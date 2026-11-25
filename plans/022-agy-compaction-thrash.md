# 022 — Antigravity compacts after every answer: budget what compaction cannot remove

Status: **approved** 2026-11-25.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill), each in the form written under its heading. Build and install follow after asking (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged except those a part names as updated. Texts marked **confirmed** are used verbatim.

## What this fixes

On `antigravity` / `gemini-4-hydrogen`, the SpeechSignalProcessing chat (`chat_mvvbllhn_781793fa`) compacted after every answer: 6 compactions between 16:50 and 17:17 on 2026-11-25, each at 33–36k estimated tokens. On Sonnet the same chat compacted at ~150k.

**Measured** (repo functions `toLlmMessages` + `antigravityRequestBytes`, chat state right after the 17:17 compaction): the next request is **127 KB + 24 KB schema reserve = 151 KB** against the 160 KB trigger (`AGY_COMPACT_AT_BYTES`).

| Part | KB | Removed by compaction? |
|---|---|---|
| Teaching instructions (static, every chat) | 46 | no |
| Tool-schema reserve | 24 | no |
| Lesson record (unit cut 2026-11-24, u1–u7 finished) | 32 | no |
| Compaction summary | 12 | replaced |
| PDF reader brief | 7.5 | yes |
| Course-method notes (current unit u3) | 11.6 | dropped, then injected again next turn |
| Kept turns | ~18 | yes |

**Root cause.** `agyKeepRecentBytes` (`src/agent/antigravity/request.ts`) sizes the kept tail as half of what is left under the trigger after the instructions, the schema reserve and the summary. It leaves out (1) the lesson record, which the projection always carries, and (2) the course notes that `courseNotesFor` injects again on the very next turn, because a compaction makes them "not live". Arithmetic: fixed counted = 47 + 24.6 + 16 = 88 KB → tail budget 36 KB → after compaction 47 + 24.6 + 32 + 12 + 36 ≈ 151 KB. The next turn adds ~15 KB of notes plus ~4 KB of answer and grading → ~170 KB → compaction again. The code comment above `agyKeepRecentBytes` records the same symptom being fixed once before; the lesson record (plan 001) and the per-unit notes (plan 007) came after or were not counted.

Contributing:
- The lesson record's "Plan" section is a log of every question asked per node (23 of 32 KB here: 93 questions).
- A compaction forces a full replay on the next turn (plan 019 rule), so thrash also throws away the agy conversation cache every turn.
- The 160 KB trigger applies to every turn, even though a resumed agy request only sends the new messages; the 192 KB cap (`AGY_MAX_INPUT_BYTES`, agy truncates any input message above it) binds only on a full replay.

## Owner decisions (2026-11-25)

1. **Scope:** all four parts below.
2. **No gain:** when a compaction would leave less than one turn's room, don't compact; send normally until the hard 192 KB cap and show a one-line notice in the chat.
3. **Lesson record log:** per node, result counts plus the newest question not answered right (text and result).
4. **Existing records:** condensed at replay; the stored chat stays unchanged on disk.
5. **Course notes:** kept through a compaction (current unit scope), not injected again.
6. **Resume-aware trigger:** while the agy conversation is resumable, compact by the model window (Hydrogen 128k − 16k reserve ≈ 112k tokens, `effectiveThresholdTokens` as for other models). The 160 KB byte rule still applies before any turn that needs a full replay.

## Texts (**confirmed** 2026-11-25)

- **No-gain notice** (chat notice, shown once per compaction span when a compaction was skipped for no gain):
  > The conversation is close to this model's size limit, and compacting now would not free enough room. You can keep going; if the limit is reached, switch to a model with a larger context.
- **Condensed node block** in the lesson record's "Plan" section (replaces the per-question lines under each node line; node and unit lines stay):
  ```
  - [visited] Least squares: error orthogonal to regressors (orth)
      · 4 asked: 2 right, 2 didn't know
      · newest gap: check — "For a $p=2$ predictor, the condition $E\{e[n]\,x[n-2]\}=0$ …" — didn't know
  ```
  A node with no question gets no `·` lines. A node whose questions were all right gets only the counts line.

## Spec-level choices (approved with this plan)

- **Result category** of a question line (`    · <type> — "<text>" — <result>`): the result with a trailing ` (…)` removed (`wrong (picked "…")` → `wrong`). Counts list categories in order of first appearance under that node, joined `, `, as `N asked: <count> <category>, …`. **Newest gap** = the last line under the node whose category is not `right`, printed as `newest gap: <type> — "<text>" — <full result>`.
- **Condensing** is one pure function `condenseLessonRecordPlan(text)` in `src/core/lesson-record.ts`. `renderLessonRecord` applies it to new records; the projection applies it to every stored record when it is sent to a model (all providers). Text outside the "## Plan" section is unchanged. Idempotent: an already condensed record is returned unchanged.
- **Notes kept through a compaction:** when a compaction (or unit cut) is written, the course notes due for the kept region (`courseNotesFor` over the post-compaction messages) are appended right after the compaction marker in the same write. So they are live at once, counted in the post-compaction size, and the next turn has nothing to inject. Scope stays the current unit (`courseNotesFor` unchanged).
- **Budget fix:** the agy kept-tail budget counts as fixed: the instructions, the schema reserve, the expected summary (`max(prior, 16 KB)`), the projected lesson record (condensed), and the notes appended by the compaction. Tail = half of what remains under `AGY_COMPACT_AT_BYTES`.
- **No gain:** if `AGY_COMPACT_AT_BYTES − fixed < 16 KB` (`AGY_MIN_TURN_ROOM_BYTES`), the compaction is skipped, the turn is sent as is (the existing 192 KB backstop still refuses an oversize request), and a `compaction-skipped` notice marker (not sent to the model) is written once per compaction span.
- **Resumable check:** a helper extracted from `src/agent/antigravity/stream.ts` (`agyResumableLink(chatId, model, systemPrompt, tools, messages)`) is used by both the stream and the compaction gate. If the gate cannot compute the coming turn's exact tools, it treats the turn as a full replay (today's byte rule), the safe default.
- **Tool-schema reserve** stays at 24 KB (not in scope).

## Part 1 — Course notes kept through a compaction

Form: full

**Spec (approved, from the plan's shared sections).** When a compaction (or unit cut) is written, the course notes due for the kept region (`courseNotesFor` over the post-compaction messages) are appended right after the compaction marker in the same write. So they are live at once, counted in the post-compaction size, and the next turn has nothing to inject. Scope stays the current unit (`courseNotesFor` unchanged).

**Files.** `src/server/compaction.ts` (compaction write appends due notes), `src/server/unit-cut.ts` (same after a unit cut), `src/core/course-notes.ts` (reuse `courseNotesFor`, no behaviour change).

**Tests** (new `tests/compaction-keeps-notes.test.ts`): after a compaction in a chat with binding material and units, the record has the course-files, reference and current-unit method notes right after the compaction marker; `courseNotesFor` on that record returns nothing; a chat without material gets no notes; a unit cut does the same.

## Part 2 — Condensed lesson record

Form: full

**Spec (approved, from the plan's shared sections).**
- **Result category** of a question line (`    · <type> — "<text>" — <result>`): the result with a trailing ` (…)` removed (`wrong (picked "…")` → `wrong`). Counts list categories in order of first appearance under that node, joined `, `, as `N asked: <count> <category>, …`. **Newest gap** = the last line under the node whose category is not `right`, printed as `newest gap: <type> — "<text>" — <full result>`.
- One pure function `condenseLessonRecordPlan(text)` in `src/core/lesson-record.ts`. `renderLessonRecord` applies it to new records; the projection applies it to every stored record when it is sent to a model (all providers); the stored chat on disk is unchanged. Text outside the "## Plan" section is unchanged. Idempotent.
- **Condensed node block** (**confirmed**, verbatim format; replaces the per-question lines under each node line; node and unit lines stay):
  ```
  - [visited] Least squares: error orthogonal to regressors (orth)
      · 4 asked: 2 right, 2 didn't know
      · newest gap: check — "For a $p=2$ predictor, the condition $E\{e[n]\,x[n-2]\}=0$ …" — didn't know
  ```
  A node with no question gets no `·` lines. A node whose questions were all right gets only the counts line.

**Files.** `src/core/lesson-record.ts` (`condenseLessonRecordPlan`, used by `renderLessonRecord`), `src/core/native-messages.ts` (projection applies it to lesson-record markers).

**Tests** (new `tests/lesson-record-condense.test.ts`; fixture: the "## Plan" section of the stored record, copied into the test file): the `orth` block becomes the confirmed example; an all-right node keeps only its counts line; a node without questions keeps only its node line; text outside "## Plan" is byte-identical; condensing twice equals condensing once; the fixture shrinks from ~23 KB to under 9 KB.

## Part 3 — Budget fix and no-gain skip

Form: full

**Spec (approved, from the plan's shared sections).**
- The agy kept-tail budget counts as fixed: the instructions, the schema reserve (stays 24 KB), the expected summary (`max(prior, 16 KB)`), the projected lesson record (condensed, Part 2), and the notes appended by the compaction (Part 1). Tail = half of what remains under `AGY_COMPACT_AT_BYTES`.
- **No gain:** if `AGY_COMPACT_AT_BYTES − fixed < 16 KB` (`AGY_MIN_TURN_ROOM_BYTES`), the compaction is skipped, the turn is sent as is (the existing 192 KB backstop still refuses an oversize request), and a `compaction-skipped` notice marker (not sent to the model) is written once per compaction span.
- **No-gain notice** (**confirmed**, verbatim):
  > The conversation is close to this model's size limit, and compacting now would not free enough room. You can keep going; if the limit is reached, switch to a model with a larger context.

**Files.** `src/agent/antigravity/request.ts` (`agyKeepRecentBytes` takes the extra fixed bytes, `AGY_MIN_TURN_ROOM_BYTES`), `src/server/compaction.ts` (`antigravityKeptTail` passes lesson record and due-note bytes; skip rule; notice marker), the view/notice rendering for `compaction-skipped`.

**Tests** (new `tests/agy-compaction-budget.test.ts`): replaying the measured composition (46 KB instructions, 32 KB record, 15 KB notes, 3–4 KB turns) through the compaction gate: after a compaction the projected request leaves ≥ 16 KB under the trigger, and the next 3 turns of 4 KB do not compact again; with fixed ≥ trigger − 16 KB, no compaction runs and one notice marker is written; the notice is not in the model context.

## Part 4 — Resume-aware trigger

Form: full

**Spec (approved, from the plan's shared sections).**
- While the agy conversation is resumable, compact by the model window: `effectiveThresholdTokens(setting, window)` (Hydrogen 128k − 16k ≈ 112k tokens), as for other models. Before any turn that needs a full replay (model change, edited/retried message, changed system prompt or tools), the existing 160 KB byte rule applies, with the existing chained summary passes when one summary request does not fit.
- A helper extracted from `src/agent/antigravity/stream.ts` (`agyResumableLink(chatId, model, systemPrompt, tools, messages)`) is used by both the stream and the compaction gate. If the gate cannot compute the coming turn's exact tools, it treats the turn as a full replay (byte rule), the safe default.

**Files.** `src/agent/antigravity/link.ts` or `stream.ts` (`agyResumableLink`), `src/server/compaction.ts` / `src/server/chat-handler.ts` (gate: resumable → token threshold `effectiveThresholdTokens(setting, window)`; full replay → byte rule with chained passes), `docs/architecture.md` (compaction on agy: budget, notes, record, resume trigger, no-gain notice).

**Tests** (new `tests/agy-resume-trigger.test.ts`): a resumable chat at 170 KB / 45k tokens does not compact; at 115k tokens it does; the same chat with a changed model, system prompt or edited message compacts by the byte rule before the turn, in chained passes when one summary request does not fit; unknown tools at the gate → byte rule.

## Last stage — build and install (after the parts, not a ladder part)

`desktop:dist`, replace `/Applications/LearnHarness.app`, after asking.

## Status per part

- Part 1: **green** 2026-11-25 (build-review/20261125-194017-022-part-1, 2 rounds). Notes are appended only for non-practice chats with a tree, matching chat-handler.
- Part 2: **green** 2026-11-25 (build-review/20261125-195832-022-part-2, 3 rounds, 1 ruling). Open: `native-messages.ts` ↔ `lesson-record.ts` import cycle (call-time only); a result containing `" — ` would split wrongly.
- Part 3: **green** 2026-11-25 (build-review/20261125-202945-022-part-3, 5 rounds, 1 ruling). The plugin-API reference now lists `compaction-skipped`. Due notes are estimated with earlier note markers removed (over-counts, the safe direction).
- Part 4: **green** 2026-11-25 (build-review/20261125-211454-022-part-4, 3 rounds). `agyResumableLink` is shared, but both chat-handler gates run before the agent's tools are built, so the gate treats every turn as a full replay (byte rule): the resume-aware trigger is not active in the app yet. A resumable compaction uses the token kept tail.
- Hand check after the queue: typecheck, lint, tests 6867 pass / 0 fail / 2 skipped. One test batch was killed by the 300 s hang guard during the Part 2 run (load), and its later gates passed.
