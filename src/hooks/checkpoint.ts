import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { textParts } from "../core/content";

/**
 * Pre-compaction checkpoint (pi-vcc-mini addition).
 *
 * When context usage reaches `checkpointThreshold`, a one-shot message asks
 * the model to write a short status note. The note leads the next compaction
 * summary as a [Checkpoint] section (see summarize.ts) when its exchange
 * falls before the cut. When it is still inside the kept tail it is not
 * pinned: it stays in the context unchanged, and the summary sits ahead of
 * the tail, so a summary-level copy would show the note before messages that
 * are already newer than it. A note that was never pinned survives only as
 * brief transcript text after the next compaction.
 *
 * Injection points:
 *  - turn_end: a custom_message entry appended via the boundary API plus
 *    continue:true. When the run continues (tool results pending), the natural
 *    next request satisfies `continue` and carries the appended message; when
 *    the run is ending, continue:true forces one more response, so the
 *    checkpoint exists before the user types the next message.
 *  - before_agent_start for user-prompted runs already above threshold
 *    (covers a single huge tool result jumping past the threshold).
 *  - manual /compact and /pi-vcc: session_before_compact is cancelled once,
 *    the checkpoint runs as its own turn, then compaction re-triggers via
 *    pi.compact() with the original instructions.
 *
 * The checkpoint request message itself is excluded from the summarizer
 * input (it is identical boilerplate every time) — see
 * effectiveSkipCustomTypes() — while the model's response stays available to
 * the summarizer and is pinned only in the case described above.
 */

/** customType of the checkpoint request message. */
export const CHECKPOINT_CUSTOM_TYPE = "vcc-checkpoint-request";

/** Fallback: if a manual compact's checkpoint turn never ends, compact anyway. */
const MANUAL_COMPACT_TIMEOUT_MS = Number(process.env.PI_VCC_CKPT_TIMEOUT_MS ?? 180_000);

/** Opt-in lifecycle tracing: PI_VCC_CKPT_DEBUG=1. */
const ckptLog = (...a: unknown[]): void => {
  if (process.env.PI_VCC_CKPT_DEBUG) console.error("[vcc-ckpt]", ...a);
};

interface CheckpointState {
  /** One-shot guard: already requested a checkpoint in this warning window. */
  fired: boolean;
  /** Manual compact intercepted; waiting for the checkpoint run to finish. */
  manualPending: { customInstructions?: string } | null;
  /** The run currently executing was started by our checkpoint message. */
  checkpointRunActive: boolean;
  /** Re-triggered compaction after a checkpoint; do not intercept again. */
  retriggering: boolean;
  /** agent_end of the checkpoint run already re-triggered compaction. */
  manualDone: boolean;
}

const state: CheckpointState = {
  fired: false,
  manualPending: null,
  checkpointRunActive: false,
  retriggering: false,
  manualDone: false,
};

export const resetCheckpointState = (): void => {
  state.fired = false;
  state.manualPending = null;
  state.checkpointRunActive = false;
  state.retriggering = false;
  state.manualDone = false;
};

/** True while a manual compaction is waiting for its checkpoint turn. */
export const isManualCompactPending = (): boolean => state.manualPending !== null;

/**
 * skipCustomTypes as the summarizer should see it: the user's list plus our
 * checkpoint request marker (boilerplate, regenerated every window).
 */
export const effectiveSkipCustomTypes = (settings: PiVccSettings): string[] =>
  [...new Set([...settings.skipCustomTypes, CHECKPOINT_CUSTOM_TYPE])];

const AUTOMATIC_CHECKPOINT_ENDING = "Afterward, resume the task normally.";
const MANUAL_CHECKPOINT_ENDING = "Stop after the note; compaction will follow automatically.";

/** Manual compaction must not turn into more task work before the retry. */
const manualCheckpointPrompt = (prompt: string): string =>
  prompt.includes(AUTOMATIC_CHECKPOINT_ENDING)
    ? prompt.replace(AUTOMATIC_CHECKPOINT_ENDING, MANUAL_CHECKPOINT_ENDING)
    : `${prompt}\n\n${MANUAL_CHECKPOINT_ENDING}`;

const checkpointMessage = (settings: PiVccSettings, manual = false) => ({
  customType: CHECKPOINT_CUSTOM_TYPE,
  content: manual ? manualCheckpointPrompt(settings.checkpointPrompt) : settings.checkpointPrompt,
  display: true,
  details: undefined,
});

const clearManualTimer = (() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    arm(fn: () => void) {
      this.clear();
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, MANUAL_COMPACT_TIMEOUT_MS);
    },
  };
})();

/**
 * Persistent window guard: a checkpoint request marker already sits in the
 * active branch after the last compaction AND produced a note. The in-memory
 * `fired` flag is lost when the host process restarts (`pi -c`, SDK hosts);
 * scanning the branch keeps the "one checkpoint per warning window" rule
 * across restarts without re-reading the session file. Walks backwards: a
 * completed marker+note pair before any compaction entry means this window
 * is already covered. The note check is the same primitive the summarizer
 * uses (findCheckpointSpan): a marker whose reply never produced text — the
 * turn was truncated and dropped, or the host died mid-turn, or the user
 * typed a new prompt before a response landed — is a FAILED checkpoint and
 * must not block re-firing for the rest of the window.
 */
export const checkpointAlreadyInWindow = (
  ctx: ExtensionContext | undefined,
): boolean => {
  const getBranch = (ctx as { sessionManager?: { getBranch?: () => unknown[] } } | undefined)
    ?.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return false;
  let branch: unknown[] = [];
  try {
    branch = getBranch.call((ctx as { sessionManager: object }).sessionManager) ?? [];
  } catch {
    return false;
  }
  return findCheckpointSpan(branch) !== undefined;
};

/**
 * Re-trigger the cancelled manual compaction with its original
 * instructions. ctx.compact() is fire-and-forget: failures surface only
 * through onError, never as a throw, so a failed re-trigger must reset the
 * retriggering flag itself or later manual compacts would skip their
 * checkpoint (interceptManualCompact treats retriggering as "in progress").
 */
const retriggerCompact = (
  ctx: ExtensionContext | undefined,
  customInstructions: string | undefined,
): void => {
  state.retriggering = true;
  try {
    (ctx as { compact?: (options: unknown) => void } | undefined)?.compact?.({
      customInstructions,
      onComplete: () => ckptLog("re-triggered compact completed"),
      onError: (err: Error) => {
        ckptLog("re-triggered compact failed:", err.message);
        state.retriggering = false;
      },
    });
  } catch (e) {
    ckptLog("ctx.compact threw synchronously:", e);
    state.retriggering = false;
  }
};

/**
 * Called from session_before_compact (hooks/before-compact.ts) for manual
 * compactions. Returns true when the compaction was cancelled so a
 * checkpoint can run first; the caller must then return { cancel: true }.
 */
export const interceptManualCompact = (
  pi: ExtensionAPI,
  settings: PiVccSettings,
  customInstructions: string | undefined,
  ctx: ExtensionContext | undefined,
): boolean => {
  if (!settings.checkpointEnabled) return false;
  if (state.retriggering || state.manualPending) return false;
  // A checkpoint already exists in this window (threshold path fired, or a
  // second /compact): compact immediately.
  if (state.fired) return false;
  if (checkpointAlreadyInWindow(ctx)) return false;

  state.fired = true;
  state.manualPending = { customInstructions };
  ckptLog("manual compact intercepted, sending checkpoint request");
  clearManualTimer.arm(() => {
    const pending = state.manualPending;
    if (!pending) return;
    state.manualPending = null;
    retriggerCompact(ctx, pending.customInstructions);
  });
  try {
    pi.sendMessage(checkpointMessage(settings, true), { triggerTurn: true });
    ckptLog("sendMessage returned without throwing");
  } catch (e) {
    ckptLog("sendMessage threw:", e);
    // Delivery failed: fall through to the timer, which compacts anyway.
  }
  return true;
};

/** session_before_compact proceeds (not cancelled): clear the retrigger flag. */
export const noteManualCompactProceeding = (): void => {
  state.retriggering = false;
};

/** A compaction completed: re-arm the checkpoint for the next window. */
export const noteCompacted = (): void => {
  state.fired = false;
  state.manualPending = null;
  state.retriggering = false;
  state.manualDone = false;
  clearManualTimer.clear();
};

export const registerCheckpointSystem = (pi: ExtensionAPI): void => {
  pi.on("session_start", () => {
    resetCheckpointState();
  });

  pi.on("before_agent_start", (event, ctx) => {
    ckptLog(`before_agent_start messageType=${event.messageType}`);
    if (event.messageType === "custom" && (event as any).message?.customType === CHECKPOINT_CUSTOM_TYPE) {
      state.checkpointRunActive = true;
      return;
    }
    if (event.messageType !== "user") return;
    const settings = loadSettings();
    if (!settings.checkpointEnabled || state.fired) return;
    if (checkpointAlreadyInWindow(ctx)) return;
    const usage = (ctx as any)?.getContextUsage?.() as { percent: number | null } | undefined;
    if (usage?.percent == null || usage.percent < settings.checkpointThreshold * 100) return;
    state.fired = true;
    return { message: checkpointMessage(settings) };
  });

  pi.on("turn_end", (event, ctx) => {
    const settings = loadSettings();
    if (!settings.checkpointEnabled || state.fired) return;
    if (checkpointAlreadyInWindow(ctx)) return;
    if ((event as any).outcome !== "completed") return;
    const usage = (ctx as any)?.getContextUsage?.() as { percent: number | null } | undefined;
    if (usage?.percent == null || usage.percent < settings.checkpointThreshold * 100) return;
    state.fired = true;
    // Boundary API: append the request and ensure one next provider request.
    // With tool results pending that request is the run's own next turn (the
    // message rides between the tool batch and the next LLM call, prefix
    // intact); without them, continue:true forces the checkpoint response
    // before the user types the next message. The one-shot `fired` guard is
    // the loop protection continue:true requires.
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: CHECKPOINT_CUSTOM_TYPE,
          content: settings.checkpointPrompt,
          display: true,
        },
      ],
      continue: true,
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    ckptLog(`agent_end checkpointRunActive=${state.checkpointRunActive}`);
    if (!state.checkpointRunActive) return;
    state.checkpointRunActive = false;
    const pending = state.manualPending;
    if (!pending || state.manualDone) return;
    state.manualDone = true;
    clearManualTimer.clear();
    state.manualPending = null;
    retriggerCompact(ctx, pending.customInstructions);
  });

  pi.on("session_compact", (event) => {
    ckptLog("session_compact reason=", (event as { reason?: string })?.reason);
    noteCompacted();
  });
  pi.on("session_compact_failed", (event) => {
    ckptLog(
      "session_compact_failed reason=",
      (event as { reason?: string })?.reason,
      "error=",
      (event as { errorMessage?: string })?.errorMessage,
    );
    // Our own cancellation of a manual compact (checkpoint-first flow) is
    // not a failure: cancelling emits session_compact_failed with
    // errorMessage undefined while the checkpoint turn is still pending.
    // Wiping manualPending here would kill both the agent_end re-trigger
    // and the timeout fallback. Re-arm only for real failures.
    if (state.manualPending || state.checkpointRunActive) return;
    noteCompacted();
  });
};

// ── Checkpoint extraction (summarizer input) ──────────────────────────────

const isAssistantTextEntry = (entry: any): boolean =>
  entry?.type === "message" && entry.message?.role === "assistant";

const entryEndsRun = (entry: any): boolean => {
  if (entry.type === "compaction" || entry.type === "custom_message" || entry.type === "branch_summary") return true;
  return entry.type === "message" && entry.message?.role === "user";
};

const assistantTextOf = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Text parts only: thinking blocks are reasoning, not the status note.
  return textParts(content).join("\n");
};

export interface CheckpointSpan {
  /** The model's checkpoint text (assistant text parts after the marker). */
  text: string;
  /** Entry id of the checkpoint request marker. */
  markerId: string;
}

/**
 * The checkpoint note: the FIRST text-bearing assistant reply after the
 * marker, kept IN FULL. The scan ends at a user message / custom message /
 * branch summary / compaction / branch end — the model's reply to a later
 * prompt is not the note. Tool results in between belong to the same run
 * and are skipped. Thinking blocks never count: they are invisible to
 * compaction. No size cap — the prompt asks for a short note, and a rare
 * oversized reply is cheaper than clipping logic.
 */
export const findCheckpointSpan = (branchEntries: any[]): CheckpointSpan | undefined => {
  let markerIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (e?.type === "compaction") break; // marker before the last compaction is gone
    if (e?.type === "custom_message" && e.customType === CHECKPOINT_CUSTOM_TYPE) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx < 0) return undefined;

  for (let i = markerIdx + 1; i < branchEntries.length; i++) {
    const e = branchEntries[i];
    if (entryEndsRun(e)) return undefined; // run over, no note was written
    if (isAssistantTextEntry(e)) {
      const text = assistantTextOf(e.message).trim();
      if (text) return { text, markerId: branchEntries[markerIdx].id };
    }
  }
  return undefined;
};

/**
 * The checkpoint to pin into the next summary: the model's note when the
 * exchange falls inside the summarized prefix (selectedIds), undefined when
 * it is still in the kept tail (survives on its own) or does not exist.
 */
export const checkpointForSummary = (
  branchEntries: any[],
  selectedIds: ReadonlySet<string>,
): string | undefined => {
  const span = findCheckpointSpan(branchEntries);
  if (!span) return undefined;
  if (!selectedIds.has(span.markerId)) return undefined;
  return span.text;
};
