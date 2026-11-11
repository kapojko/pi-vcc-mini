# pi-vcc-mini

> Fork of [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) tuned for **small local models with slow prefill and short context** — the setup where a 99.5% prompt-cache hit rate is the whole point. Two additions on top of upstream 0.11.2:
>
> - **Pre-compaction checkpoint (A):** when context reaches ~80%, the model is asked (once per window) to write a short status note — Goal / Done / Next / Notes. The note rides the cached prefix (near-zero prefill cost) and is **pinned as a `[Checkpoint]` section** into every later pi-vcc summary, so the model's own line of thought survives the algorithmic brief. The section is marked as an earlier snapshot, with later messages taking precedence. Manual `/compact` and `/pi-vcc` ask for the note and stop, then compact.
> - **grep-style `vcc_recall` (B):** the model-facing tool is a lean grep — `query` + optional `before`/`after` context entries, `'#N'` for full entries — at **773 chars of declaration vs 2395 upstream (−68%)**. Line-granular output, chronological order, lenient repair of grep flags (`-C 3`) typed into the query. The full multi-mode surface stays available to you via `/pi-vcc-recall` and `recallProfile: "full"`.
>
> Everything else is upstream pi-vcc: algorithmic compaction (no LLM call, ~1 ms), smart keep-tail, session-global `#N` refs. Config lives in `~/.pi/agent/pi-vcc-mini.json` (separate from upstream's `pi-vcc-config.json`, so both can coexist). Requires Pi >= 1.5.0.

## Install

```
pi install git:github.com/kapojko/pi-vcc-mini
```

## Fork settings (on top of upstream's)

The config is **never created or written by the extension** — unset keys always follow the built-in defaults, which new versions may change. Write a key to `~/.pi/agent/pi-vcc-mini.json` yourself to pin it:

| Key | Default | Meaning |
|---|---|---|
| `checkpointEnabled` | `true` | Ask the model for a status note before compaction |
| `checkpointThreshold` | `0.8` | Fire when `getContextUsage().percent >= threshold×100` |
| `checkpointPrompt` | built-in | The checkpoint request text (Goal/Done/Next/Notes); manual compaction adds a stop instruction |
| `recallProfile` | `"grep"` | `"grep"` = lean tool for models; `"full"` = upstream surface |

See [VERIFICATION.md](./VERIFICATION.md) for the test plan and live-model scenarios.

---

# pi-vcc (upstream)

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls: it builds the summary by extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) (View-oriented Conversation Compiler).

## Demo

![pi-vcc demo](https://raw.githubusercontent.com/sting8k/pi-vcc/master/demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input, same output |
| **Size reduction** | Varies | 97.6% median, 89% at p10 |
| **Compaction latency** | Waits for an LLM call | 1 ms median, 11 ms p90, 348 ms worst |
| **Cost** | Burns tokens on the summarization call | None |
| **History after compaction** | Gone, the agent only sees the summary | Searchable with `vcc_recall` |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and stay capped |
| **Structure** | Free-form prose | Up to 6 sections + a brief transcript |

Size and latency measured over 1,884 real sessions (summary chars vs the summarized conversation). How much of a session's facts survive is measured in [`benchmarks/README.md`](./benchmarks/README.md).

pi-vcc also takes over `/compact` and automatic compactions, makes its own cut when Pi's cut leaves nothing to summarize, and adds `/pi-vcc` for compacting on demand.

## Install

```bash
pi install npm:@sting8k/pi-vcc
```

Or from GitHub:

```bash
pi install https://github.com/sting8k/pi-vcc
```

Or try without installing:

```bash
pi -e https://github.com/sting8k/pi-vcc
```

## Usage

pi-vcc runs automatically when your context window fills up, or on demand:

- `/pi-vcc` compacts now, keeping the last user turn.
- `/pi-vcc keep:N [prompt]` keeps the last `N` user turns (`keep:0` compacts everything) and sends the optional prompt to the agent afterwards.

With the default `keep:1`, a small tail is grown automatically (see `smartKeepTail`). To leave `/compact` and automatic compactions to Pi core, set `overrideDefaultCompaction: false`.

On a short session `/pi-vcc` can answer "Nothing to compact yet" whatever `keep:N` says: Pi stops before any extension runs while the whole session still fits in the recent part it always keeps (`compaction.keepRecentTokens` in Pi's settings).

### Compacted message structure

```
[Early Session Requests]
- Fix the auth bug, users can't log in after password reset
- It happens only after a password reset, not after a normal logout

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Tracked Commands]
- docker: docker compose restart api 2>&1

[User Messages]
- Always run tests before committing
- Also update the session token refresh logic

---

...(28 earlier lines omitted)

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset... (#11)
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
* bash "docker compose restart api 2>&1" (#15)
* bash "bun test tests/auth.test.ts" (#16)

---

Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.
```

A section only appears when it has something to say; a session with no git commits has no `[Commits]`.

| Section | Contents |
|---|---|
| `[Early Session Requests]` | The session's first 3 user messages, as written. Set once; they can be stale later in a long session |
| `[Files And Changes]` | Files modified, created or read (capped, paths trimmed to a common root) |
| `[Commits]` | Last 8 commits made in the session (hash + subject) |
| `[Tracked Commands]` | Recent runs of only the commands listed in `trackCommands` (off by default) |
| `[User Messages]` | The 15 newest later user messages, as written (one line each, up to 300 characters) |
| Brief transcript | The conversation in order, about 120 recent lines, each tool call shortened to one line with a `(#N)` ref |

On the next compaction, the sections are merged with the previous summary and re-capped, and the transcript rolls forward. `[Early Session Requests]` stays as the first summary set it. None of the sections depend on wording, so they work the same in every language.

## Recall

Pi's default compaction drops old messages for good. `vcc_recall` reads the raw session file instead, so anything compacted away stays reachable. It searches the active conversation lineage by default; `scope:"all"` also covers edited or retried branches. Only the current session is searchable.

### The model's tool (default: grep profile)

One string query in, matching **lines** out — chronological, case-insensitive, `#N`-tagged — plus optional neighbor entries:

```
vcc_recall({ query: "auth token" })               // matching lines, 1 entry of context each side
vcc_recall({ query: "auth token", after: 3 })     // more context entries
vcc_recall({ query: "hook|inject" })              // regex works
vcc_recall({ query: "#1253" })                     // entry #1253 in full (summary refs point here)
```

Multi-word queries match the literal phrase first, then fall back to per-term OR. Grep flags typed into the query (`"-C 3 auth"`) are understood. Context is rendered in before/hit/after order, with shared neighbors deduplicated. The declaration is 773 chars (upstream's full surface: 2395).

### Your command: `/pi-vcc-recall` (full surface, any profile)

```
/pi-vcc-recall auth token            // ranked search, 5 per page
/pi-vcc-recall auth token scope:all   // edited/retried branches too
/pi-vcc-recall auth token page:2
```

Set `recallProfile: "full"` in `~/.pi/agent/pi-vcc-mini.json` to give the model the upstream multi-mode tool instead (query/range/expand/touched/scope/page).

## How it works

1. Pick the cut: everything before the kept tail is summarized, the tail stays as is.
2. Normalize Pi messages into uniform blocks and drop noise (system messages, empty blocks).
3. Extract the sections and the brief transcript, and format them.
4. If there is a previous summary, merge into it.

No step calls a model, and token counts are estimated from the session's own numbers.

## Config

Config lives at `pi-vcc-config.json` in Pi's agent directory (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR` if set) and is created with these defaults on first load:

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false,
  "skipForProviders": [],
  "skipCustomTypes": [],
  "trackCommands": []
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: pi-vcc handles `/pi-vcc`, `/compact` and automatic compactions. With `false` it only handles `/pi-vcc`. Existing config files keep their value.
- **`smartKeepTail`** *(default `true`)*: if the `keep:1` tail is under 5k tokens, keep as many turns as fit in 25k. This is pi-vcc's own limit; Pi's `compaction.keepRecentTokens` does not change it. An explicit `keep:N` is always respected.
- **`continueAfterThresholdCompact`** *(default `true`)*: after an automatic compaction, tell the agent to carry on instead of stopping. Only used on pi < 0.84.4; newer pi resumes on its own. `false` turns it off everywhere.
- **`debug`** *(default `false`)*: write details of each compaction (message counts, cut, sections, token calibration) to `/tmp/pi-vcc-debug.json`.
- **`skipForProviders`** *(default `[]`)*: providers for which pi-vcc steps aside, so another compaction extension can handle them. Compared case-insensitively with Pi's provider id (see `/model`; Grok is `xai`). Checked on every compaction; `/pi-vcc` always runs.
- **`skipCustomTypes`** *(default `[]`)*: `customType` values of `custom_message` entries to leave out of the summary, for per-turn boilerplate other extensions inject (skill cards, guidance blocks). Exact, case-sensitive match; look for `"type":"custom_message"` in your session file to find the value. Only the summary input changes, not the cut.
- **`trackCommands`** *(default `[]`)*: commands to remember across compactions, listed in a `[Tracked Commands]` section. Any command or prefix works: `["ssh", "kubectl", "docker"]`, `["psql", "./deploy.sh"]`, or `"gh pr"` (matches `gh pr merge`, not `gh run`). Each entry is the command as written, up to the next shell separator outside quotes, with any `sudo`/`env`/`VAR=` prefix kept; the 10 most recent per command are kept. Only `bash` calls are read, and only `ssh` remote commands are looked into, not `sh -c` or `docker exec`. Empty = off.

## Benchmarks

Benchmarks comparing the ranked brief with the 0.3.18 baseline (recall, fact density, precision, size) are in [`benchmarks/README.md`](./benchmarks/README.md).

## Acknowledgments

- [VCC](https://github.com/lllyasviel/VCC), the original transcript-preserving conversation compiler.
- Recall `mode:"touched"` and `#N:path` drill-down ported from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik), who also suggested the feature.
- Invisible auto-continue pattern ported from [monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc) (`tom` branch) by [@monotykamary](https://github.com/monotykamary).

## License

MIT
