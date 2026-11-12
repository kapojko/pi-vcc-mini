import { readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_PATH_DEFAULT = join(getAgentDir(), "pi-vcc-mini.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface PiVccSettings {
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /**
   * Permission (not a guarantee) for pi-vcc's own continue after a successful
   * automatic compaction (threshold, or overflow after the assistant already
   * finished with stop). It avoids a UX cliff where the agent finishes a response,
   * immediately compacts, and then stops instead of continuing the task.
   *
   * false = never continue. true (default) = continue only on Pi versions that
   * still need the fallback: Pi >= PI_SELF_RESUME_VERSION resumes the run itself,
   * so pi-vcc stays silent there even when this is true (issue #22). A version
   * that cannot be parsed is treated as new Pi, i.e. no continue.
   * Overflow retry is still owned by pi-core via willRetry.
   */
  continueAfterThresholdCompact: boolean;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * Providers for which pi-vcc defers compaction entirely (issue #27), e.g.
   * providers that ship their own remote compaction via another extension.
   * Matched case-insensitively against ctx.model.provider (Pi's provider id —
   * check /model; Grok is "xai", not "grok"). Explicit /pi-vcc bypasses the
   * skip. Unknown/undefined model never skips.
   */
  skipForProviders: string[];
  /**
   * customType values whose custom_message entries are excluded from the
   * summarizer input. Opt-in (default []). Intended for per-turn boilerplate
   * injected by other extensions that is regenerated every turn.
   * Exact match on customType. Filtering happens right before summarization:
   * cut selection, token calibration, firstKeptEntryId and kept-user-turn
   * counting are all unaffected.
   */
  skipCustomTypes: string[];
  /**
   * Commands whose bash invocations are kept in a "[Tracked Commands]" section,
   * e.g. `["ssh", "kubectl"]`, `["psql"]`, or a prefix like `"gh pr"`. Each
   * entry is the command as written up to the next unquoted separator
   * (`;`/`&`/`|`/newline) -- no per-command argument parsing. Also scans an
   * `ssh host "<remote command>"` string for the other tracked names.
   * Empty by default (feature off).
   */
  trackCommands: string[];
  /**
   * Pre-compaction checkpoint (pi-vcc-mini): when context usage reaches
   * checkpointThreshold, a one-shot message asks the model to write a short
   * status note (Goal / Done / Next / Notes) that leads the next compaction
   * summary as a [Checkpoint] section when it was written before the kept
   * tail (a note inside the tail stays there and is not repeated). The
   * checkpoint turn rides the existing prefix, so it costs almost no prefill
   * on cache-friendly backends. Manual /compact and /pi-vcc also checkpoint
   * first (compaction is cancelled once, the checkpoint runs, then compaction
   * re-triggers).
   */
  checkpointEnabled: boolean;
  /** Fire the checkpoint when getContextUsage().percent >= this (0..1). Default 0.8. */
  checkpointThreshold: number;
  /** Text sent to the model as the checkpoint request. */
  checkpointPrompt: string;
  /**
   * Model-facing vcc_recall surface. "grep" (default): a lean grep-style
   * search (query + before/after), ~1/6 of the token cost, tuned for small
   * local models. "full": the upstream multi-mode tool. The /pi-vcc-recall
   * command keeps the full surface in both profiles.
   */
  recallProfile: "grep" | "full";
}

/**
 * Closing instruction of the automatic checkpoint prompt: the note is not an
 * end-of-run report, the task continues after it. Shared with
 * hooks/checkpoint.ts, which swaps it out for a stop instruction on manual
 * compaction, so both files must read the same constant.
 *
 * The wording is deliberately explicit ("immediately", "do not end the run
 * with the note alone"): small local models treat a status-note request as a
 * wrapping-up signal and otherwise stop after the note, leaving the task
 * stalled until the user nudges it (see TODO_checkpoint_continue.md).
 */
export const AUTOMATIC_CHECKPOINT_ENDING =
  "After the note, if work remains, continue immediately with the next action from Next, using tools as needed. Do not end the run with the note alone; stop only when the task is already complete.";

export const DEFAULT_CHECKPOINT_PROMPT = [
  "Write a checkpoint for the upcoming context compaction.",
  "",
  "Write it directly in chat, using these labels:",
  "Goal: the overall session objective.",
  "Done: completed work, including files, commands, and outcomes.",
  "Next: the immediate remaining actions.",
  "Notes: important decisions, constraints, and pitfalls.",
  "",
  "Be factual, self-contained, and concise (6-12 lines).",
  "Do not create files or call tools just to produce this note.",
  "Only your reply text is pinned into the next compaction summary.",
  AUTOMATIC_CHECKPOINT_ENDING,
].join("\n");

/** Exact 1.0.1-1.0.2 built-in (the weak "Afterward, resume" line), migrated on load. */
export const LEGACY_CHECKPOINT_PROMPT_1_0_1 = [
  "Write a checkpoint for the upcoming context compaction.",
  "",
  "Write it directly in chat, using these labels:",
  "Goal: the overall session objective.",
  "Done: completed work, including files, commands, and outcomes.",
  "Next: the immediate remaining actions.",
  "Notes: important decisions, constraints, and pitfalls.",
  "",
  "Be factual, self-contained, and concise (6-12 lines).",
  "Do not create files or call tools to produce this note.",
  "Only your reply text is pinned into the next compaction summary.",
  "Afterward, resume the task normally.",
].join("\n");

/** Exact 1.0.0 built-in, migrated on load; user-customized prompts are untouched. */
export const LEGACY_DEFAULT_CHECKPOINT_PROMPT = [
  "IMPORTANT: reply with the note directly in your chat response. Do not use the write or any other tool for it, and do not create files like SUMMARY.md, LOG.md or notes — files are compacted away too, and only your reply text survives as the checkpoint.",
  "",
  "Context checkpoint: the context window is filling up and will be compacted soon.",
  "Before continuing, write a brief status note (10-20 lines, dense and factual):",
  "1. The overall goal of this session.",
  "2. Work completed so far — files, commands, results.",
  "3. The exact next steps you were about to take.",
  "4. Key decisions, constraints, gotchas.",
  "This note is your main anchor after compaction, so keep it self-contained.",
  "Write the note now as plain reply text, then continue the task.",
].join("\n");

/** Every superseded built-in prompt; an exact match means "unset", not "custom". */
const LEGACY_CHECKPOINT_PROMPTS: readonly string[] = [
  LEGACY_DEFAULT_CHECKPOINT_PROMPT,
  LEGACY_CHECKPOINT_PROMPT_1_0_1,
];

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
  skipForProviders: [],
  skipCustomTypes: [],
  trackCommands: [],
  checkpointEnabled: true,
  checkpointThreshold: 0.8,
  checkpointPrompt: DEFAULT_CHECKPOINT_PROMPT,
  recallProfile: "grep",
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/** Coerce a config value to string[], failing closed to []. */
const coerceStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  // A blind spread would leak a malformed array value (e.g. a bare string,
  // where .includes becomes substring matching) into the provider check.
  merged.skipForProviders = coerceStringArray(parsed.skipForProviders);
  merged.skipCustomTypes = coerceStringArray(parsed.skipCustomTypes);
  // Blank names would match every command; duplicates would repeat lines.
  merged.trackCommands = [
    ...new Set(coerceStringArray(parsed.trackCommands).map((s) => s.trim()).filter(Boolean)),
  ];
  // Checkpoint settings: coerce defensively — a bad value falls back to the default.
  merged.checkpointEnabled = typeof parsed.checkpointEnabled === "boolean" ? parsed.checkpointEnabled : DEFAULT_SETTINGS.checkpointEnabled;
  merged.checkpointThreshold =
    typeof parsed.checkpointThreshold === "number" && Number.isFinite(parsed.checkpointThreshold) && parsed.checkpointThreshold > 0 && parsed.checkpointThreshold <= 1
      ? parsed.checkpointThreshold
      : DEFAULT_SETTINGS.checkpointThreshold;
  merged.checkpointPrompt =
    typeof parsed.checkpointPrompt === "string" &&
    parsed.checkpointPrompt.trim().length > 0 &&
    !LEGACY_CHECKPOINT_PROMPTS.includes(parsed.checkpointPrompt)
      ? parsed.checkpointPrompt
      : DEFAULT_SETTINGS.checkpointPrompt;
  merged.recallProfile = parsed.recallProfile === "full" ? "full" : "grep";
  return merged;
}

/**
 * The config file is never created or written by the extension: unset keys
 * always follow the built-in defaults, which new versions may change; a key
 * written by the user pins it. (Historically, 1.0.0 scaffolded the full
 * default block — an exact legacy built-in prompt found there is treated as
 * unset. Every superseded built-in is listed in LEGACY_CHECKPOINT_PROMPTS.)
 */
