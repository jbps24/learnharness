# 005 — Antigravity: an unusable run falls back to Sonnet, including runs that invented transcript turns

Status: **approved** 2026-11-22.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the part through the ladder (`execute-plan` skill): `ladder chunk --plan plans/005-agy-invented-turns.md --step "Part 1"`.
3. After the part is green, update "Status per part" below.

## What this fixes

In the Regelungssysteme chat (2026-11-22 12:51, message `msg_mwrs3i5r_47b9f04e`) the teacher told the learner that all five units were done while the lesson was in Unit 3, node `nyq`. The agy run (`~/.gemini/antigravity-cli/brain/3328ce2f-…/transcript_full.jsonl`) shows how:

1. Gemini did not answer. It wrote 27k tokens of prose that continued the replayed transcript: 18 invented turns with `[assistant]`, `[tool call …]` and `[tool result …]` lines and invented learner answers, through Units 3–5. This is the failure `AGY_TRANSCRIPT_END` in `src/agent/antigravity/request.ts` guards against. It happened 5 times on 2026-11-20 before that guard (all Gemini 4 Hydrogen), and this is the first time since.
2. It never called agy's `finish`, so agy sent its own nudge ("You did not call any tools …"). Gemini then called `finish` with the **last invented assistant message** as `text`.
3. `src/agent/antigravity/stream.ts` retries only when `structured_output` is missing. Here it was present, so the invented ending became a real teacher turn.

agy's `result` event carries the run's whole prose as `result.response` (checked 2026-11-22 with agy's stream-json output: the prose before `finish`, followed by the envelope JSON). The replay format (`src/agent/claude-code/transcript.ts`) writes turns as lines starting `[user]`, `[assistant]`, `[tool call <name>]` and `[tool result <name>]` / `[tool result <name> error]`, and `AGY_TRANSCRIPT_END` tells the model never to write them. A run whose `response` contains such a line has invented turns.

## Owner decisions (2026-11-22)

1. A run with invented turns is **unusable**, like a run without structured output.
2. The one retry after an unusable run goes to **Claude Sonnet 5.5 through agy** (`--model claude-sonnet-5-5`), not to the same model again. If that run is unusable too, the turn ends with the existing `ANTIGRAVITY_NO_ANSWER` error.
3. A turn answered by the fallback is recorded as **`claude-sonnet-5-5`** (the message's `model`), so usage shows which turns fell back.

## Part 1 — Detect invented turns; the retry runs on Sonnet

**Code** (`src/agent/antigravity/stream.ts`):
- New exported constant `ANTIGRAVITY_FALLBACK_MODEL = "claude-sonnet-5-5"`.
- New exported function `inventedTurns(response: unknown): boolean`. It returns true when `response` is a string with at least one line (multiline, at line start, no leading whitespace) matching `^\[(user|assistant|tool call [^\]\n]+|tool result [^\]\n]+)\]`. A non-string or missing `response` returns false.
- A run is **unusable** when `envelope.structured_output == null` or `inventedTurns(envelope.response)` is true.
- The first run is unchanged (selected model, its `--effort`). After an unusable first run (unless aborted), exactly one more run starts with the same prompt and the same args, except:
  - `--model` is `ANTIGRAVITY_FALLBACK_MODEL` (replacing the selected model's `--model`, or added when the selected model is `default` and had none);
  - `--effort` follows the fallback model's `thinkingLevelMap` from `ANTIGRAVITY_MODELS` (`src/agent/antigravity/provider.ts`) for `options.reasoning`, except `xhigh` and `max` become `high`. A level the map does not support otherwise (`off`, `minimal`) or no `options.reasoning` → no `--effort`, as on the first run.
  - This also holds when the selected model already is `claude-sonnet-5-5`: the retry runs Sonnet again.
- A second unusable run, for either reason in any combination, throws `ANTIGRAVITY_NO_ANSWER` (text unchanged). There is at most one retry per request.
- When the fallback run is used, `message.model` is set to `ANTIGRAVITY_FALLBACK_MODEL` before any event is pushed with its content. Parsed actions, usage and events come from the run that is used, as today. `message.provider` and `message.api` stay.
- The comment above the retry names both reasons and the fallback.

**Tests** (`tests/antigravity.test.ts`; new helpers only; the existing `fakeRun` and `success` may be called, not changed):
- `inventedTurns`: true for `"Text\n\n[tool result explain]\n{…}"`, `"[assistant]\nHi"`, `"x\n[tool call quiz] {}"`, `"x\n[user]\nhello"`, `"x\n[tool result quiz error]\nboom"`. False for `undefined`, `42`, `""`, `"plain prose"`, `"see [assistant] inline"` (not at line start), `"  [assistant]"` (leading spaces), `"[Session note] x"`, `"[Image: read this file]"`.
- Gemini 4 Hydrogen, reasoning `medium`: first run has a valid `structured_output` but `response` contains `"\n[tool result explain]\n"`, second run clean with text `"Second try"` → 2 runs; same prompt; second args have `--model claude-sonnet-5-5` and `--effort medium`, and otherwise equal the first run's args; result text `"Second try"`, `stopReason` `"stop"`, `result.model` `"claude-sonnet-5-5"`, `result.usage.output` from the second run.
- Reasoning `xhigh` on Gemini 4 Hydrogen → first run `--effort xhigh`, fallback run `--effort high`.
- Model `default` (no `--model` on the first run) → the fallback run has `--model claude-sonnet-5-5`.
- Two runs both with invented turns → 2 runs, `stopReason` `"error"`, `errorMessage` equal to `ANTIGRAVITY_NO_ANSWER`, private cwd removed.
- First run without `structured_output`, second with invented turns → 2 runs, the same error. First with invented turns, second without `structured_output` → the same.
- A clean run whose `response` is plain prose followed by the envelope JSON → 1 run, its actions used, `result.model` the selected model.
- The existing test "a successful run without structured output is retried once with the same request" changes: it is renamed "… is retried once on the fallback model", and instead of `deepEqual` on the args it asserts the second run's `--model` is `claude-sonnet-5-5` and the prompt is equal. All other existing tests keep passing unchanged.

**Docs.** None: `docs/architecture.md` does not describe the agy provider; the comment in `stream.ts` is the record.

---

## Status per part

| Part | Status | Build id |
|---|---|---|
| 1 Invented turns and the Sonnet fallback | green, build-review/20261123-213255-005-part-1 | - |
