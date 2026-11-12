# TODO: continue after an automatic checkpoint

Status: known behaviour, not a bug in the current design. This note records the
situation and the options in case it becomes a frequent annoyance.

## What happens

An automatic checkpoint is injected at `turn_end` with `continue: true`. Pi
turns that into exactly **one** more request: the model writes the note, and
that turn is the one the flag requested. On the note's own `turn_end` the
one-shot guard (`state.fired`) makes the extension return nothing, so the run
ends when the note is a plain reply with no tool call. The prompt line
"Afterward, resume the task normally" is advice, not a control signal:
whether the model continues with a tool call after the note is up to the model.

Example: a model finishes a step, receives the checkpoint request, replies with
only Goal / Done / Next / Notes, and stops. The task resumes when the user asks
"did you finish?". The same model on another turn may continue with tool calls
right after the note instead.

Consequences: the task can stall mid-flight until the user nudges it, and the
compaction then happens at the end of the nudged run.

## Mitigations (pick one when it matters)

1. **Guarded continue after the note.** Detect the note turn (last entries are
   the checkpoint marker plus a text-only assistant reply, no tool call) and
   send one invisible continue with its own one-shot guard. Do not apply it to
   the manual `/compact` variant, which intentionally stops after the note.
2. **Prompt hardening.** Add to the automatic prompt: continue with the next
   action after the note, do not end the turn with the note alone. Cheapest,
   no lifecycle change, still model-dependent.
3. **Accept and document.** Keep the current behaviour; the user nudge is one
   message.

Risks for (1): ghost/empty turns, cache effects, and a compaction trigger
racing the continue; it needs its own tests and a kill switch.
