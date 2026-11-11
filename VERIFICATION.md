# pi-vcc-mini verification plan

Three layers. Layers 1–2 are already wired into `bun test`:

- **Layer 1 (offline, no LLM)** — checkpoint span extraction, `[Checkpoint]` pinning / replace-not-accumulate / kept-in-full note, stale-snapshot notice, manual-compact interception + stop instruction + re-trigger, grep flag repair, grep line matching / caps / chronological deduplicated context / `#N` routing, declaration-size regression guard (`tests/checkpoint.test.ts`, `tests/grep-recall.test.ts`).
- **Layer 2 (offline, declaration cost)** — `grep` profile measures **773 chars** vs **2395** for `full` (−68%); pinned by test.

## Layer 3 — live mechanics (any model pi defaults to; a fast local model keeps runs short)

Set `~/.pi/agent/pi-vcc-mini.json` to `{"checkpointThreshold": 0.01, "debug": true}` so the checkpoint fires on the first turn. Check each scenario in the TUI **and** in the session JSONL (entry order) + `/tmp/pi-vcc-debug.json`. S3/S4 can also be driven through the SDK with `bun run scripts/verify-live-s3s4.ts` / `verify-live-s4.ts` (paths configurable via `PI_VCC_*` env vars, see the script header).

| # | Scenario | How | Pass criteria |
|---|---|---|---|
| S1 | mid-run injection | ask for a multi-tool task (e.g. "list files, then read README, then count lines") | `vcc-checkpoint-request` custom_message appears **after the tool results, before the next assistant message**; model writes a status note, then continues the task |
| S2 | run-end force | single-response task (no tools) | one checkpoint turn is forced after the response; **exactly one** — no loop |
| S3 | manual `/compact` | run `/compact some instructions` while above threshold (first window) | order in JSONL: checkpoint request → assistant note → compaction entry; instructions preserved in the summary flow; only one compaction (no double-compact) |
| S4 | durability | trigger two compactions after a checkpoint | `[Checkpoint]` appears **once** in the latest summary, newest text |
| S5 | one-shot guard | keep working above threshold | no second checkpoint request until a compaction has happened |
| S6 | no ghost turns | let a threshold compaction fire right after a checkpoint turn | run self-resumes cleanly (pi 1.5.2), no stray empty turn |
| S7 | cache stays hot | watch the local server's metrics or usage on the checkpoint turn | prompt-cache hit rate on the checkpoint turn ≈ the session baseline (~99.5%) |

Reset config to `checkpointThreshold: 0.8` afterwards.

## Layer 4 — quality (your usual main model, real threshold 0.8)

1. Work a real multi-file task until ~80% context. The checkpoint note should let the model continue the same line after compaction without re-asking.
2. After a checkpoint survives a compaction, ask: "what were you about to do next?" — the answer should match the pre-compaction state.

## Layer 5 — grep recall, model-facing (any model, incl. a fresh session with a strong model)

A scripted end-to-end version (fact buried in a tool result, compacted away, file deleted, model must retrieve it via `vcc_recall`) lives in `bun run scripts/verify-live-recall.ts`.

1. Fill a session, let it compact, then ask: *"Earlier in this session, before compaction, we decided something about X. It is no longer in your context. Recover what was decided."*
   - Pass: first `vcc_recall` call has valid syntax (no schema errors); answer within ≤2 recall calls.
2. Negative: several normal work turns — **zero** spurious `vcc_recall` calls.
3. Syntax probes for local models (paste as user messages):
   - `Search our session history for "redis" with vcc_recall` → expect a line-granular result
   - `Use vcc_recall to read entry #N in full` (pick a real `#N` from a summary ref)
   - `Search with 3 entries of context around each hit` → expect `before`/`after` usage or `-C`-style query
4. Human surface: `/pi-vcc-recall <query>` still does ranked full search; `/pi-vcc-recall <query> scope:all` covers other branches.

## Install for live testing

```
pi install git:github.com/kapojko/pi-vcc-mini
```

(Config: `~/.pi/agent/pi-vcc-mini.json` — separate from any upstream `pi-vcc-config.json`; uninstall upstream pi-vcc first if both are present, since both register `vcc_recall`.)
