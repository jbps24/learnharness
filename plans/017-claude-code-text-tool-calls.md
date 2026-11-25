# 017 — Claude Code: tool calls written as text become real calls

Status: **approved** 2026-11-25.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Part 1 through the ladder (`execute-plan` skill): `ladder chunk --plan plans/017-claude-code-text-tool-calls.md --step "Part 1"`. Build and install follow after asking (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged. Texts marked **confirmed** are used verbatim.

## What this fixes

On the `claude-code` provider (Sonnet), the teacher sometimes ends its answer with a line such as `[tool call quiz] {"type":"check",…}`. The learner sees raw JSON instead of a quiz. In the signal-processing chat (`chat_mvvbllhn_781793fa`) this happened in 11 of 270 Sonnet turns (messages 48, 50, 52, 80, 88, 213, 257, 271, 291, 349, 365). No other provider and no other stored chat shows it.

**Root cause.** Every claude-code turn that does not continue a live CLI process starts a fresh `claude` CLI and replays the whole chat as one user message (`toClaudeInput` in `src/agent/claude-code/transcript.ts`). Past tool calls appear in that text as `[tool call <name>] <json>` lines and results as `[tool result <name>]` blocks. Sonnet copies the format and writes its next call as text instead of calling the MCP tool. This is the failure agy had (plan 005, `AGY_TRANSCRIPT_END`), but the claude-code replay has no closing instruction and no detection.

Evidence from the 11 cases:
- 7 are `stop` turns with no real call. In each the text call is the last line of the text; in 257 it is followed by an invented `[tool result quiz]` block. All JSON parses, and every tool name is declared.
- 4 are `toolUse` turns that also made a real call. In 88 and 349 the text call is the same quiz as the real call, in 291 it is a bare `[tool call explain]` header, and in 80 it is a different tool (`ask_user_question` beside the real `send_to_user`).

## Owner decisions (2026-11-25)

1. **Prevent + salvage.** Close the replay with an instruction, and repair turns that still contain a text call. No retry run.
2. **Mixed turns: strip, don't salvage.** A turn with a real call loses its replay-format lines and gets no extra call. A turn without one gets its text call salvaged as a real call, and all other replay lines are stripped, including invented results.
3. **Claude-code only.** Agy is unchanged.
4. **Old turns: strip at replay.** Stored chats stay unchanged on disk. The claude-code replay removes replay-format lines from past assistant text.

## Spec-level choices (approved with this plan)

- **Replay line**: a line that starts (column 0) with `[user]`, `[assistant]`, `[tool call <name>]` or `[tool result <name>]` / `[tool result <name> error]`. This is the same pattern as agy's `inventedTurns` (`/^\[(user|assistant|tool call [^\]\n]+|tool result [^\]\n]+)\]/m`).
- **Strip**: in an assistant text block, cut everything from the first replay line to the end of the block, then trim trailing whitespace. If nothing is left, the text block is removed from the message. All 11 cases had the replay material at the end of the block.
- **Salvage** (only for a turn that ended with `stop` and has no tool call): take the **first** `[tool call <name>] <rest>` line in the cut part of the **last** text block. If `<name>` is a declared harness tool and `<rest>` parses as a JSON object, append `{ type: "toolCall", id: randomUUID(), name, arguments }`, emit `toolcall_start` / `toolcall_end` as `admit()` does, and set `stopReason` to `"toolUse"`. **Note:** the option you picked said "last". This plan takes the **first** call instead. Anything after it was written after an invented result or learner answer (case 257), so it is invented continuation. In all 11 stored cases the cut part has at most one call, so first and last pick the same line there.
- An unsalvageable text call (unknown tool, bad JSON, the bare header in 291) is still stripped, and no call is added.
- **Strip runs on every successful end** (`stop`, `length`, `toolUse` via `admit()`). Error and aborted turns are untouched. Salvage runs only on `stop`. The text has already streamed live, so the learner sees the line briefly until the final message replaces the partial (`message_end`).
- A salvaged call reaches Pi like an admitted call. The `stop` turn has already killed its CLI process (`handleLine`: `if (this.turn.finished) this.kill()`), so the next request finds no live process and replays fresh. No MCP admission mismatch can occur.
- **Replay closing**: `toClaudeInput` is shared with agy and stays unchanged. A new `toClaudeCliInput(messages)` in `transcript.ts` (1) applies the strip rule to every past assistant text block and (2) when the conversation is replayed (anything other than a single user message), appends one final text block `CLAUDE_TRANSCRIPT_END`. A single user message stays unlabelled with no closing block, as today. `startProcess` in `stream.ts` uses `toClaudeCliInput` instead of `toClaudeInput`.
- **`CLAUDE_TRANSCRIPT_END`** (**confirmed** 2026-11-25):
  `[end of transcript]\n\nThe transcript above is complete and the learner is waiting for your next turn. Do not continue or simulate it: never write [assistant], [user], [tool call …] or [tool result …] lines, and never invent learner answers or tool results. A [tool call …] line in your text does nothing: to use a harness tool, call it through your tools.`

## Part 1 — Strip, salvage and close the replay

Form: full

**Files.** New `src/agent/claude-code/text-tool-calls.ts` (`stripReplayLines(text): { kept: string; cut: string }`, `salvageToolCall(cut, toolNames): { name; arguments } | null`). `src/agent/claude-code/transcript.ts` (`CLAUDE_TRANSCRIPT_END`, `toClaudeCliInput`). `src/agent/claude-code/stream.ts` (`ClaudeTurn.finish()` and `admit()` apply strip/salvage; `startProcess` uses `toClaudeCliInput`).

**Tests** (new files: `tests/claude-code-text-tool-calls.test.ts`, `tests/claude-code-cli-input.test.ts`, `tests/claude-code-text-call-stream.test.ts`):
- `stripReplayLines`: trailing `[tool call quiz] {…}` is cut and the prose kept, with trailing whitespace trimmed. A call followed by `\n\n[tool result quiz]\n{"kind":"quiz"}` is cut whole. `[assistant]` and `[user]` lines at line start are cut. Not cut: `see [tool call quiz] inline` (not at line start), `  [tool call quiz] {}` (leading spaces), `[Image: …]`, `[!IMPORTANT]` callouts, text without replay lines (returned unchanged, `cut` empty).
- `salvageToolCall`: a declared tool with valid JSON gives `{ name, arguments }`. Returns null for an undeclared name, invalid JSON, a JSON array, or a bare header with no JSON. With two calls in the cut part, the first one is used.
- `toClaudeCliInput`: a single user message gives exactly today's output with no closing block. A replayed conversation ends with a text block equal to `CLAUDE_TRANSCRIPT_END`. A past assistant text ending in `[tool call quiz] {…}` is replayed without that line, while the real `toolCall` block of the same message still appears as `[tool call …]`. A user message containing `[tool call quiz]` at line start is replayed unchanged. `toClaudeInput` output is unchanged (agy).
- Stream (fake CLI as in `claude-code-stream.test.ts`, new helpers only):
  - A `stop` turn whose text ends with `[tool call quiz] {"type":"check",…}` gives `stopReason` `"toolUse"`, text without the line, one `toolCall` named `quiz` with the parsed arguments, and `toolcall_start` / `toolcall_end` events.
  - The same with an undeclared tool name, or with bad JSON: `stopReason` `"stop"`, line stripped, no `toolCall`.
  - A `stop` turn whose whole text is the call gives no text block and one `toolCall`.
  - Case 257's shape (call + invented result): one `toolCall` from the call, and the result text is gone.
  - A `toolUse` turn with a real MCP-admitted `quiz` call and a text `[tool call quiz] {…}` line: text stripped, exactly one `toolCall` (the admitted one), and live-process continuation still works on the next request.
  - An error turn is left as is.
  - The stdin line of a replayed turn ends with the `CLAUDE_TRANSCRIPT_END` block.

**Docs.** None: `docs/architecture.md` does not describe the claude-code replay; the comments in `transcript.ts` and `stream.ts` are the record.

## Last stage — build and install (after the part, not a ladder part)

`npm run desktop:dist`, then ask the owner before replacing `/Applications/LearnHarness.app`.

## Status per part

| Part | Status |
|---|---|
| 1 Strip, salvage and close the replay | green (full), build-review/20261125-111014-017-part-1; open: text deltas stream replay lines live before `done` (only final content is cleaned) |
| Build and install | not started |
