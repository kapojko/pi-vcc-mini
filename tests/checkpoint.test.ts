import { describe, it, expect, beforeEach } from "bun:test";
import {
  CHECKPOINT_CUSTOM_TYPE,
  findCheckpointSpan,
  checkpointForSummary,
  checkpointAlreadyInWindow,
  effectiveSkipCustomTypes,
  interceptManualCompact,
  registerCheckpointSystem,
  resetCheckpointState,
} from "../src/hooks/checkpoint";
import { compileRanked } from "../src/core/summarize";
import { CHECKPOINT_STALENESS_NOTE } from "../src/core/format";
import { DEFAULT_SETTINGS, DEFAULT_CHECKPOINT_PROMPT, AUTOMATIC_CHECKPOINT_ENDING } from "../src/core/settings";
import type { PiVccSettings } from "../src/core/settings";
import type { Message } from "@earendil-works/pi-ai";

const msg = (id: string, role: string, content: unknown) =>
  ({ type: "message", id, message: { role, content } });
const custom = (id: string, customType: string, content: string) =>
  ({ id, type: "custom_message", customType, content, display: true, timestamp: "2026-01-01T00:00:00.000Z" });
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });
const marker = (id: string) => custom(id, CHECKPOINT_CUSTOM_TYPE, "checkpoint request boilerplate");

beforeEach(() => resetCheckpointState());

describe("checkpointAlreadyInWindow (persistent guard)", () => {
  const ctxWith = (branch: unknown[]) =>
    ({ sessionManager: { getBranch: () => branch } }) as any;
  const note = (id: string) => msg(id, "assistant", [{ type: "text", text: "Goal: fix auth." }]);

  it("sees a marker followed by an assistant note", () => {
    expect(checkpointAlreadyInWindow(ctxWith([msg("m1", "user", "hi"), marker("c1"), note("m2")]))).toBe(true);
  });

  it("sees a marker whose note arrives after tool work in the same turn", () => {
    const branch = [
      marker("c1"),
      msg("m2", "assistant", [{ type: "toolCall", id: "t1", "name": "write", "arguments": {} }]),
      msg("m3", "toolResult", [{ type: "text", text: "ok" }]),
      note("m4"),
    ];
    expect(checkpointAlreadyInWindow(ctxWith(branch))).toBe(true);
  });

  it("ignores a marker from before the last compaction", () => {
    expect(
      checkpointAlreadyInWindow(ctxWith([marker("c1"), note("m2"), comp("k1", "m3")])),
    ).toBe(false);
  });

  it("re-arms when the checkpoint response never produced text (truncated and dropped)", () => {
    // The live failure: stopReason length, thinking-only response removed by
    // pi via context_edit — the marker stays but no note follows it.
    expect(checkpointAlreadyInWindow(ctxWith([msg("m1", "user", "hi"), marker("c1")]))).toBe(false);
    expect(
      checkpointAlreadyInWindow(
        ctxWith([marker("c1"), msg("m2", "assistant", [{ type: "thinking", thinking: "The" }])]),
      ),
    ).toBe(false);
  });

  it("re-arms when a user message landed before any note (host died mid-turn)", () => {
    expect(
      checkpointAlreadyInWindow(
        ctxWith([marker("c1"), msg("m2", "user", "are you there?"), note("m3")]),
      ),
    ).toBe(false);
  });

  it("returns false for an empty branch or a missing sessionManager", () => {
    expect(checkpointAlreadyInWindow(ctxWith([]))).toBe(false);
    expect(checkpointAlreadyInWindow(undefined)).toBe(false);
    expect(checkpointAlreadyInWindow({} as any)).toBe(false);
  });

  it("survives a getBranch throw", () => {
    const ctx = { sessionManager: { getBranch: () => { throw new Error("boom"); } } } as any;
    expect(checkpointAlreadyInWindow(ctx)).toBe(false);
  });
});

describe("findCheckpointSpan", () => {
  it("collects assistant text after the last marker, up to the next user message", () => {
    const entries = [
      msg("m1", "user", "do the thing"),
      marker("c1"),
      msg("m2", "assistant", [{ type: "text", text: "Goal: fix auth.\nDone: tests pass." }]),
      msg("m3", "user", "continue"),
      msg("m4", "assistant", "later work"),
    ];
    const span = findCheckpointSpan(entries);
    expect(span?.markerId).toBe("c1");
    expect(span?.text).toBe("Goal: fix auth.\nDone: tests pass.");
  });

  it("skips thinking blocks and tool work, takes the first text-bearing reply in full", () => {
    const entries = [
      marker("c1"),
      msg("m2", "assistant", [
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "the note" },
      ]),
      msg("m3", "toolResult", [{ type: "text", text: "tool output" }]),
      msg("m4", "assistant", [{ type: "text", text: "later continuation, not the note" }]),
      msg("m5", "user", "next"),
    ];
    expect(findCheckpointSpan(entries)?.text).toBe("the note");
  });

  it("takes the note after tool work in the same run", () => {
    const entries = [
      marker("c1"),
      msg("m2", "assistant", [{ type: "toolCall", name: "read", arguments: {} }]),
      msg("m3", "toolResult", [{ type: "text", text: "tool output" }]),
      msg("m4", "assistant", [{ type: "text", text: "the note" }]),
    ];
    expect(findCheckpointSpan(entries)?.text).toBe("the note");
  });

  it("ignores a marker from before the last compaction", () => {
    const entries = [
      marker("c1"),
      msg("m2", "assistant", "old checkpoint"),
      comp("k1", "m3"),
      msg("m3", "user", "after compaction"),
    ];
    expect(findCheckpointSpan(entries)).toBeUndefined();
  });

  it("returns undefined without a marker or without assistant text", () => {
    expect(findCheckpointSpan([msg("m1", "user", "hi")])).toBeUndefined();
    expect(findCheckpointSpan([marker("c1"), msg("m2", "user", "no response")])).toBeUndefined();
  });
});

describe("checkpointForSummary", () => {
  const entries = [
    msg("m1", "user", "task"),
    marker("c1"),
    msg("m2", "assistant", "checkpoint body"),
  ];

  it("pins the text when the marker is in the summarized prefix", () => {
    expect(checkpointForSummary(entries, new Set(["m1", "c1", "m2"]))).toBe("checkpoint body");
  });

  it("does not pin when the exchange is in the kept tail", () => {
    expect(checkpointForSummary(entries, new Set(["m1"]))).toBeUndefined();
  });

  it("keeps an oversized reply in full — no cap, no clipping marker", () => {
    const long = [
      msg("m1", "user", "task"),
      marker("c1"),
      msg("m2", "assistant", "line one\nline two\nline three".repeat(200)),
    ];
    const out = checkpointForSummary(long, new Set(["m1", "c1", "m2"]));
    expect(out).toBe("line one\nline two\nline three".repeat(200));
    expect(out).not.toMatch(/clipped/);
  });
});

describe("effectiveSkipCustomTypes", () => {
  it("adds the checkpoint marker to the user's list, deduped", () => {
    const settings = { ...DEFAULT_SETTINGS, skipCustomTypes: ["other", CHECKPOINT_CUSTOM_TYPE] } as PiVccSettings;
    expect(effectiveSkipCustomTypes(settings)).toEqual(["other", CHECKPOINT_CUSTOM_TYPE]);
  });
});

describe("[Checkpoint] summary section", () => {
  const messages: Message[] = [
    { role: "user", content: "fix the auth bug", timestamp: 0 } as any,
    { role: "assistant", content: [{ type: "text", text: "fixed it" }], timestamp: 0 } as any,
  ];

  it("pins the model text as the leading section, marked as an earlier snapshot", () => {
    const summary = compileRanked({ messages, checkpoint: "Status: auth fixed." });
    expect(summary.startsWith(`[Checkpoint]\n${CHECKPOINT_STALENESS_NOTE}\n\nStatus: auth fixed.`)).toBe(true);
  });

  it("replaces, not accumulates, across compactions", () => {
    const first = compileRanked({ messages, checkpoint: "old status" });
    const second = compileRanked({ messages, checkpoint: "new status", previousSummary: first });
    const occurrences = second.split("[Checkpoint]").length - 1;
    expect(occurrences).toBe(1);
    expect(second.split(CHECKPOINT_STALENESS_NOTE)).toHaveLength(2);
    expect(second).toContain("new status");
    expect(second).not.toContain("old status");
  });

  it("keeps the last known checkpoint when the new window has none", () => {
    const first = compileRanked({ messages, checkpoint: "the status" });
    const second = compileRanked({ messages, previousSummary: first });
    expect(second).toContain("the status");
  });

  it("preserves blank lines inside the note across a merge (free-text section)", () => {
    const note = "**Status note**\n\n1. **Goal:** fix auth.\n2. **Next:** write tests.\n\n**Gotcha:** watch retries.";
    const first = compileRanked({ messages, checkpoint: note });
    const second = compileRanked({ messages, checkpoint: note, previousSummary: first });
    // The merge re-parses the fresh [Checkpoint] section; a line-item parse
    // would cut the body at the first blank line (only "**Status note**"
    // survived). The free-text parse must keep the whole note.
    const body = second.slice(second.indexOf("[Checkpoint]"));
    expect(body).toContain("1. **Goal:** fix auth.");
    expect(body).toContain("**Gotcha:** watch retries.");
  });
});

describe("manual compact interception", () => {
  const settings = { ...DEFAULT_SETTINGS } as PiVccSettings;

  const makePi = () => {
    const handlers = new Map<string, (e: any, c: any) => any>();
    const sent: any[] = [];
    const compacts: any[] = [];
    const pi: any = {
      on: (name: string, fn: any) => handlers.set(name, fn),
      sendMessage: (m: any, o: any) => { sent.push({ m, o }); },
    };
    const ctx: any = { compact: (o: any) => { compacts.push(o); } };
    return { pi, ctx, sent, compacts, handlers };
  };

  it("cancels the first manual compact and sends the checkpoint request", () => {
    const { pi, ctx, sent } = makePi();
    expect(interceptManualCompact(pi, settings, "instructions", ctx)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].m.customType).toBe(CHECKPOINT_CUSTOM_TYPE);
    expect(sent[0].m.content).not.toBe(DEFAULT_CHECKPOINT_PROMPT);
    expect(sent[0].m.content).toContain("Goal: the overall session objective.");
    expect(sent[0].m.content).toContain("Stop after the note; compaction will follow automatically.");
    // The automatic "keep going after the note" instruction must be gone:
    // a manual checkpoint is followed by compaction, not by more task work.
    expect(sent[0].m.content).not.toContain(AUTOMATIC_CHECKPOINT_ENDING);
    expect(sent[0].m.content).not.toContain("Do not end the run with the note alone");
    expect(sent[0].o.triggerTurn).toBe(true);
  });

  it("swaps a legacy closing sentence in a pinned prompt for the stop instruction", () => {
    const { pi, ctx, sent } = makePi();
    const legacySettings = {
      ...settings,
      checkpointPrompt: "Write my custom checkpoint.\n\nAfterward, resume the task normally.",
    };
    expect(interceptManualCompact(pi, legacySettings, undefined, ctx)).toBe(true);
    expect(sent[0].m.content).toBe(
      "Write my custom checkpoint.\n\nStop after the note; compaction will follow automatically.",
    );
  });

  it("adds the stop instruction to a custom manual checkpoint prompt", () => {
    const { pi, ctx, sent } = makePi();
    const customSettings = { ...settings, checkpointPrompt: "Write my custom checkpoint." };
    expect(interceptManualCompact(pi, customSettings, undefined, ctx)).toBe(true);
    expect(sent[0].m.content).toBe(
      "Write my custom checkpoint.\n\nStop after the note; compaction will follow automatically.",
    );
  });

  it("does not intercept twice in one window, and not when disabled", () => {
    const { pi, ctx } = makePi();
    expect(interceptManualCompact(pi, settings, undefined, ctx)).toBe(true);
    expect(interceptManualCompact(pi, settings, undefined, ctx)).toBe(false);
    resetCheckpointState();
    expect(interceptManualCompact(pi, { ...settings, checkpointEnabled: false }, undefined, ctx)).toBe(false);
  });

  it("re-triggers the compaction after the checkpoint run ends", () => {
    const { pi, ctx, compacts, handlers } = makePi();
    registerCheckpointSystem(pi);

    expect(interceptManualCompact(pi, settings, "original instructions", ctx)).toBe(true);

    // The checkpoint message starts a custom run...
    handlers.get("before_agent_start")!({ messageType: "custom", message: { customType: CHECKPOINT_CUSTOM_TYPE } }, ctx);
    // ...and it ends.
    handlers.get("agent_end")!({ type: "agent_end" }, ctx);
    expect(compacts).toHaveLength(1);
    expect(compacts[0].customInstructions).toBe("original instructions");
    expect(typeof compacts[0].onError).toBe("function");
  });

  it("keeps the pending re-trigger when our own cancellation emits session_compact_failed", () => {
    const { pi, ctx, compacts, handlers } = makePi();
    registerCheckpointSystem(pi);

    expect(interceptManualCompact(pi, settings, "original instructions", ctx)).toBe(true);
    // pi core cancels the manual compact because of us and emits
    // session_compact_failed with no errorMessage — mid-checkpoint, this
    // must NOT wipe manualPending (the agent_end re-trigger needs it).
    handlers.get("before_agent_start")!({ messageType: "custom", message: { customType: CHECKPOINT_CUSTOM_TYPE } }, ctx);
    handlers.get("session_compact_failed")!({ type: "session_compact_failed", reason: "manual", aborted: true }, ctx);
    handlers.get("agent_end")!({ type: "agent_end" }, ctx);
    expect(compacts).toHaveLength(1);
    expect(compacts[0].customInstructions).toBe("original instructions");
  });

  it("re-arms on a real compaction failure outside the checkpoint flow", () => {
    const { pi, ctx, handlers } = makePi();
    registerCheckpointSystem(pi);
    interceptManualCompact(pi, settings, undefined, ctx);
    handlers.get("before_agent_start")!({ messageType: "custom", message: { customType: CHECKPOINT_CUSTOM_TYPE } }, ctx);
    handlers.get("agent_end")!({ type: "agent_end" }, ctx);
    // The re-triggered compaction failed for real (e.g. session too small):
    // manualPending is gone, so this is a genuine failure — re-arm.
    handlers.get("session_compact_failed")!({ type: "session_compact_failed", reason: "manual", errorMessage: "Compaction failed: Nothing to compact (session too small)" }, ctx);
    expect(interceptManualCompact(pi, settings, undefined, ctx)).toBe(true);
  });

  it("re-arms after a compaction completes", () => {
    const { pi, ctx, handlers } = makePi();
    registerCheckpointSystem(pi);
    interceptManualCompact(pi, settings, undefined, ctx);
    handlers.get("before_agent_start")!({ messageType: "custom", message: { customType: CHECKPOINT_CUSTOM_TYPE } }, ctx);
    handlers.get("agent_end")!({ type: "agent_end" }, ctx);
    handlers.get("session_compact")!({ type: "session_compact" }, ctx);
    // Fresh window: a manual compact intercepts again.
    expect(interceptManualCompact(pi, settings, undefined, ctx)).toBe(true);
  });
});
