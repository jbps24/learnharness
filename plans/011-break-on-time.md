# 011 — Breaks come on time, mid-node included

Status: **approved** 2026-11-23.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–3 through the ladder (`execute-plan` skill) as one queue; Part 4 alone with `--no-tests-first`.
3. After each part is green, update "Status per part" below.
4. Rules for every part: existing tests keep passing unchanged, except the tests a part names as updated. New test helpers only. The texts marked **confirmed** are used verbatim.

## What this changes

Plan 002 lets the teacher pick the moment: a node end, better a unit end. In practice (2026-11-23, Regelungssysteme) the window opened at 42 min of learning and the break came 20–60 min later, twice only after the escalation note. The owner's rules (2026-11-23):

1. **At the interval, the next turn breaks.** The window opens at the break interval itself (no 5-minute lead). In its next turn the teacher answers the learner's input briefly and then suggests the break instead of going on, mid-node included. No waiting for a node or unit end.
2. **One more question.** When exactly one question remains until the current node is closed, the teacher may offer it first: "one question would close the node; answer it before the break?" The learner sees the divider with **Take** and **Answer it first**. Answer it first: the teacher poses that question at once, and right after the learner's answer it suggests the break again. This skip is not counted as a declined break.
3. **The escalation note stays as a safety net**, no longer time-based: when a window note got no suggestion in the teacher's next turn, the next learner input carries the escalation note.
4. **After a skip, the next offer comes 20 minutes of learning later**, fixed (not scaled with the interval), with no limit on how often (the "two skips in a row, then quiet" rule goes).

Unchanged: the learner can ask for a break any time; the interval, length and reset settings; Take, the countdown, Continue; cut preparation at a unit end (it runs whenever the break happens to fall on one); the guards that a window break needs teaching started and no open question.

## Part 1 — Core: timings, the window, skips, escalation

**Files.** `src/core/breaks.ts`. Updated tests: `tests/break-state.test.ts`, `tests/breaks-core-mutants.test.ts`, `tests/break-settings.test.ts` (the timings examples), `tests/break-inactivity-reset.test.ts` and `tests/break-away-skip.test.ts` where they assert lead, escalation timing or the two-skip rule. New test: `tests/break-on-time.test.ts`.

- `breakTimings`: `leadMs = 0`; `reofferMs = 20 × 60 000` for every interval; `escalateMs` is removed from `BreakTimings` (and from every reader).
- `breakState`:
  - First window opens at `intervalMs` (it was `intervalMs − leadMs`).
  - A window-requested skip sets `nextOpenAtMs = skip learning time + reofferMs`; `skipsInRow` is still counted (for the view) but never makes `nextOpenAtMs` null.
  - A skip of a suggestion with `oneMoreQuestion: true` (the tool argument, Part 2, read from the `suggest_break` call like `requestedBy`) does not count in `skipsInRow` and sets `nextOpenAtMs` to the learning time of the skip (due at once).
  - `escalated` as today; the window gains `answeredSince: boolean`: true when a main-transcript learner action exists after the window's newest note.
- `breakNotesFor`:
  - Window note as today when the window is due, except: right after a one-more-question skip it is appended only to the next learner input of kind `answer`, `plugin-question-answer`, `plugin-problem-submission` or `thinking` (the answer to that question), not to `text`.
  - Escalation note when a window is open, not escalated, and `answeredSince` is true (it replaces the time rule `openedAtMs + escalateMs`).

**Tests** (`tests/break-on-time.test.ts`): the window opens at 45:00 and not at 40:00 (interval 45) and at 60:00 for interval 60; a skip at 50 min re-offers at 70 min, a second and a third skip still re-offer 20 min after each; a one-more-question skip at 46 min makes the window due at once, its note rides the next `answer` input and not a `text` input, and `skipsInRow` stays 0; escalation rides the first learner input after the window note when no suggestion came, and only once; no escalation while a suggestion is pending.

## Part 2 — The tool, the skip route, the turn after "Answer it first"

**Files.** `src/agent/tools/breaks.ts`, `app/api/chats/[id]/break/route.ts` (the skip action), `src/core/native-messages.ts` (the `break-skipped` details), `src/server/chat-handler.ts` (the turn start), `src/core/input-events.ts`. Updated tests: `tests/suggest-break-tool.test.ts`, `tests/break-route.test.ts`, `tests/break-followups.test.ts`. New test: `tests/break-one-more-question.test.ts`.

- `suggest_break` gains `oneMoreQuestion?: boolean` (only with `requestedBy: "window"`; with `"learner"` it is refused with R5 below). Its result details carry it. The guards stay (window open, teaching started, no open question, no pending offer).
- New refusal R5 (**confirmed**): `oneMoreQuestion only goes with requestedBy "window".`
- Tool description (**confirmed**): `Offer the learner a short break. Call it when a [Session note] says a break is due, in that same turn, or whenever the learner asks for one (requestedBy "learner"). First say it in one line of ordinary prose, then call this tool and end your turn. With oneMoreQuestion true, your line offers the one question that would close the current node first. The learner chooses in the app; don't ask them again in prose.`
- Skip of a one-more-question offer (the existing skip action): appends `break-skipped` with `details.oneMoreQuestion: true` and then starts a teacher turn whose input carries one `break-note` (`kind: "one-more-question"`, `display: false`), text (**confirmed**): `[Session note] The learner wants to answer the one remaining question of this node before the break. Pose it now. After their answer, give one line of feedback and suggest the break (requestedBy "window").` The turn start follows the `break-continue` path (409 while a turn runs).
- A plain skip stays UI-only, as today.

**Tests.** The argument round-trips in the result details; R5; the skip of a one-more-question offer appends the marker with the flag and starts exactly one teacher turn carrying the note; a plain skip starts no turn; 409 during a running turn.

## Part 3 — The note texts, the doctrine, the divider label

**Files.** `src/core/breaks.ts` (`windowNoteText`, `ESCALATION_NOTE_TEXT`), `src/agent/prompts/teacher/45-breaks.md`, `components/break-divider.tsx`. Updated tests: `tests/prompt-breaks-doctrine.test.ts`, `tests/break-view.test.ts`, `tests/breaks-ui-mutants.test.tsx`. New test: `tests/break-texts.test.ts`.

- Window note (**confirmed**): `[Session note] The learner has been learning for about ${interval} minutes. In this turn, respond to their input in one line, then suggest a short break instead of going on: say so in one line, call suggest_break with requestedBy "window" and end your turn. Mid-node is fine. If exactly one question remains until the current node is closed, you may instead offer it first: say in one line that one question would close the node and ask whether they want to answer it before the break, then call suggest_break with requestedBy "window" and oneMoreQuestion true.`
- Escalation note (**confirmed**): `[Session note] A break is overdue. In this turn, respond to the learner's input in one line, then suggest the break.`
- `45-breaks.md` (**confirmed**, replaces the first two paragraphs; the "learner is back" paragraph stays):

  > The app keeps time. When a [Session note] says a break is due, suggest it in that same turn: one line on the learner's input, then one line that this is a good moment for a break, call `suggest_break`, and end your turn. Mid-node is fine; don't wait for a node or unit end, and don't pose a new question first. Only when exactly one question would close the current node may you offer it first (`oneMoreQuestion` true). A question still open waits for its answer; the note rides that answer.
  >
  > Don't add advice on how to rest; the app shows that. If the learner asks for a break at any time, say yes in one line and call `suggest_break` with requestedBy "learner".

- Divider: for an offer with `oneMoreQuestion`, the Skip button reads `Answer it first` (Take unchanged).

**Tests.** Exact note texts for intervals 45 and 60; the prompt text in the composed teacher prompt; the divider label for both offer kinds.

## Part 4 — Docs (`--no-tests-first`)

- `CONTEXT.md`: **closed point** is no longer a break rule; **break window** opens at the interval; add **one-more-question offer**.
- `docs/architecture.md`: the break flow section (window at the interval, next-turn suggestion, one-more-question, escalation on the next input, fixed 20-minute re-offer).
- `plans/002-learning-breaks.md`: one line under its status: "Timing rules superseded by plan 011."
- Last stage: `npm run desktop:dist`, then replace `/Applications/LearnHarness.app` (ask the owner to quit the app first).

## Status per part

| Part | Status |
|---|---|
| 1 Core: timings, window, skips, escalation | green, build-review/20261124-010845-011-part-1; ruled test fix build-review/20261124-013243-011-part-1 |
| 2 Tool, skip route, the turn after "Answer it first" | green, build-review/20261124-014313-011-part-2 |
| 3 Note texts, doctrine, divider label | green, build-review/20261124-021204-011-part-3 |
| 4 Docs, build, install | green, build-review/20261124-023543-011-part-4; build and install pending (owner quits the app first) |
