# 002 — Learning breaks: suggest a short break about every 45 minutes of a teaching lesson

Status: **approved** 2026-11-21 (spec-level choices 1–11 and all DRAFT texts in Parts 1–7 confirmed as written; the settings placement was corrected first).
Timing rules superseded by plan 011.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part. Walk the owner through "Spec-level choices for owner review" and every **DRAFT** text in the part about to run, one question at a time (AGENTS.md "No guessing"). Write the answers into this file, then mark it approved.
2. Run parts through the ladder (`execute-plan` skill): `ladder queue --plan plans/002-learning-breaks.md --step "Part 1" …`. Part 8 takes `--no-tests-first`.
3. After each green part, update "Status per part" below. Never re-open the decisions the tickets hold.

## What this builds

During a teaching lesson the app keeps a **learning clock** from transcript timestamps. Shortly before the **break interval** (45 min by default) it opens a **break window** with a hidden note to the teacher. The teacher then makes a **break suggestion** at the next **closed point** by calling a new `suggest_break` tool after one line of prose. The learner sees a divider with **Take** and **Skip**. Take opens a full-screen countdown from the **break length** (10 min by default). **Continue** (or Esc) ends the break, resets the clock and starts a teacher turn that re-orients the learner in one line. At a unit-end break, the app builds the finished unit's lesson record while the learner is away. A global setting turns break suggestions off and sets the interval and the length.

Vocabulary (repo-root `CONTEXT.md`): **learning time**, **break interval**, **break length**, **break window**, **break suggestion**, **closed point**, plus **unit cut** and **lesson record** from plan 001.

Decisions this plan implements (each ticket holds the full rationale; do not re-open them):

- `.scratch/learning-breaks/issues/01-research-break-timing.md`: the evidence.
- `.scratch/learning-breaks/issues/02-grilling-who-decides.md`: the app opens a window, the teacher picks the moment (amended by 06).
- `.scratch/learning-breaks/issues/03-grilling-closed-block.md`: closed points, the open-question guard, teaching phase only.
- `.scratch/learning-breaks/issues/04-grilling-learning-time.md`: the clock (amended by 08).
- `.scratch/learning-breaks/issues/05-prototype-break-suggestion-ui.md`: the divider, the countdown screen (prototype: branch `prototype/break-suggestion`).
- `.scratch/learning-breaks/issues/06-grilling-window-timing.md`: opening, escalation, skips (amended by 08).
- `.scratch/learning-breaks/issues/07-grilling-returning-from-break.md`: Continue, cut preparation, away notes.
- `.scratch/learning-breaks/issues/08-grilling-break-settings.md`: the settings.
- Map: `.scratch/learning-breaks/map.md`.

Out of scope: practice sessions (`kind: "practice"`); focus or idle tracking; sounds or OS notifications; per-lesson break settings.

## Rules for every part

- Tests are new files under `tests/` (flat, `*.test.ts` / `*.test.tsx`, run by `npm test`). **Do not reuse or edit existing test fixtures or helpers**; write new helpers inside the new test files. Existing tests must keep passing unchanged, except where a part names a test it updates.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`.
- Pure logic lives in `src/core/` (no server imports); server wiring in `src/server/` and `app/api/`; agent tools in `src/agent/`; UI in `components/`.
- Every time-dependent function takes `now: number` (ms) as a parameter; tests never read the wall clock.
- Every agent-facing and learner-facing text is exact text from this plan.
- Line numbers below were read on `feat/antigravity-cli` @ b9c77e62; re-locate by symbol name if they moved.

## Spec-level choices for owner review

The map settled the design. These smaller choices were made while writing the spec. The owner confirmed all eleven as written on 2026-11-21:

1. **The teacher's line is prose.** The teacher writes its one line as ordinary text and then calls `suggest_break`. The tool carries no wording. (Ticket 02 said the tool carries the line; the prototype showed the line as prose above the divider, so this amends 02.)
2. **Who asked** is the tool argument `requestedBy: "window" | "learner"`, taken as given. The app can't verify a learner's request.
3. **Learner-requested breaks** work whenever the teacher agent runs (from planning on). Window breaks also need teaching to have started (at least one teach-tagged `quiz`/`explain` call).
4. **Writing on = Skip** counts only main-transcript learner activity. A side-chat message doesn't settle a pending offer.
5. **Take and Skip wait for the turn.** The divider's buttons are disabled while a turn runs, and the route refuses with 409 if one does.
6. **The teacher isn't told about Take or Skip.** Both are UI-only markers. The teacher learns of a break only through the Continue note.
7. **Out-of-range settings** clamp to the range and snap to the step (interval to a multiple of 5, length to whole minutes). Non-numbers are dropped (default applies).
8. **Notes ride learner inputs only.** Window, escalation, re-sent and away notes are appended only to learner inputs of a teaching turn: `text`, `answer`, `plugin-question-answer`, `plugin-problem-submission`, `thinking`. Not to automatic wakes, retries, the SDK `continue`, or `break-continue`.
9. **A prepared lesson record is used only on an exact match.** The span the real cut summarizes must hold exactly the messages the preparation summarized (markers excluded) under the same previous record. Otherwise the cut runs as today. Its usage is recorded at the cut, as today.
10. **The divider doesn't show minutes of learning.** The view has no clock, and the prototype's "46 min of learning" is dropped.
11. **The away note's threshold is the break length**, the same gap that resets the clock (ticket 08). Superseded by plan 004: the threshold is `breaks.resetMinutes`.

---

## Part 1 — Break settings

**Goal.** The settings record carries `breaks`; resolution fills defaults; the derived timings are one pure function; the Agent section gets a "Breaks" group.

**Files.**
- `src/core/settings.ts`:
  - `export interface BreakSettings { enabled?: boolean; intervalMinutes?: number; lengthMinutes?: number }`; `UserSettings.breaks?: BreakSettings`;
  - `sanitizeBreaks(raw: Record<string, unknown>): BreakSettings`, called from `sanitizeUserSettings` (~l.901) like `sanitizeCompaction`. `enabled`: boolean or dropped. `intervalMinutes`: a finite number is clamped to [20, 90], then rounded to the nearest multiple of 5. `lengthMinutes`: clamped to [5, 20], then rounded to an integer. Anything else is dropped.
  - export `BREAK_DEFAULTS = { enabled: true, intervalMinutes: 45, lengthMinutes: 10 } as const` and the bounds `BREAK_INTERVAL_RANGE = { min: 20, max: 90, step: 5 }`, `BREAK_LENGTH_RANGE = { min: 5, max: 20, step: 1 }`.
- `src/core/settings-resolution.ts`: `EffectiveSettings.breaks: { enabled: boolean; intervalMinutes: number; lengthMinutes: number }`, filled from the record over `BREAK_DEFAULTS` in `resolveSettings` (~l.185).
- New `src/core/breaks.ts`: `export interface BreakTimings { intervalMs: number; lengthMs: number; leadMs: number; escalateMs: number; reofferMs: number }` and `breakTimings(s: { intervalMinutes: number; lengthMinutes: number }): BreakTimings`. Lead = `round(interval / 9)` min; escalate = reoffer = `round(interval × 4 / 9)` min; all in ms.
- `components/settings/agent-section.tsx`: a `SettingsGroup label="Breaks" testid="group-breaks"` after "Context" (~l.926), with three rows (copy below). The two number rows show only while the toggle is on. They save through the same settings write path the other Agent rows use.
- New tests: `tests/break-settings.test.ts`, `tests/break-settings-section.test.tsx`.

**Settings copy (confirmed).**
- Toggle row: label `Break suggestions`, hint `Off = no break offers; you can still ask for a break`.
- Number row: label `Break interval`, hint `minutes of learning (20–90)`.
- Number row: label `Break length`, hint `minutes (5–20)`.

**Tests.**
- `sanitizeUserSettings({ version: 1, breaks: { enabled: false, intervalMinutes: 47, lengthMinutes: 3.6 } })` gives `breaks: { enabled: false, intervalMinutes: 45, lengthMinutes: 5 }`. `intervalMinutes: 200` → 90; `"x"` is dropped.
- `resolveSettings(null).breaks` equals `{ enabled: true, intervalMinutes: 45, lengthMinutes: 10 }`.
- `breakTimings({ intervalMinutes: 45, lengthMinutes: 10 })` gives lead 5, escalate 20, reoffer 20 (min). At 20 → 2/9/9. At 90 → 10/40/40. `lengthMs` = 600 000 at 10.
- The section renders the group with the toggle; the number rows are hidden when `enabled: false`.

---

## Part 2 — Break markers and the learning clock (pure core)

**Goal.** Four new transcript markers, wired into the existing classifiers. A pure replay of the transcript gives the learning clock, the window state, and the notes due for a new learner input.

**Files.**
- `src/core/native-messages.ts`:
  - `LhMarkerMessage.customType` (~l.89) gains `"break-note" | "break-taken" | "break-skipped" | "break-ended"`;
  - constructors: `newBreakNoteMessage(kind: "window" | "escalation" | "away", text: string, windowId?: string)` (`display: false`, `details: { kind, windowId }`, where a fresh window note's `windowId` is its own id); `newBreakTakenMessage(toolCallId: string, lengthMinutes: number)`; `newBreakSkippedMessage(toolCallId: string)`; `newBreakEndedMessage(toolCallId: string, breakMs: number, text: string)`. All take an optional `now` for the timestamp (default `Date.now()`);
  - `nativeInputCause` (~l.1000): `break-taken`, `break-skipped` and `break-ended` → `"learner"`; `break-note` → `"neutral"`;
  - `toLlmMessages` (~l.672): `break-note` and `break-ended` go on the wire as user text (their `content`), like `units-note`; `break-taken` and `break-skipped` are filtered (UI-only);
  - the neutral list (~l.1006) and `src/core/input-events.ts` (~l.402) skip list include `break-note`.
- `src/server/unit-cut.ts` `withoutMarkers` (~l.32): also drops the four break markers.
- `src/core/breaks.ts` (extends Part 1):
  - `learnerActivityTimes(messages: readonly LhMessage[], sideChats: readonly SideChatThread[] | undefined): number[]`: the timestamps of every message whose `nativeInputCause` is `"learner"`, plus `Date.parse(at)` of every side-chat message with `role: "user"`, sorted.
  - `learningClock(messages, sideChats, timings: BreakTimings, now: number): LearningClock`, where `LearningClock = { learningMs: number; startedAt: number | null; awayMs: number | null }`. Walk the transcript in order, tracking `activityEnd`: a learner action sets it to its own time; an assistant or tool-result message whose turn a learner action triggered (the last trigger before it, by `nativeInputCause`, was `"learner"`) extends it to `timestamp + (durationMs ?? 0)`; messages of automatically triggered turns never extend it. A learner action whose gap since `activityEnd` is ≥ `timings.lengthMs` is a reset, and the clock starts at that action. A `break-ended` marker is a reset at its own time. `learningMs = now − startedAt` (0 when `startedAt` is null). `now` is treated as a learner action: if its gap since `activityEnd` is ≥ `lengthMs`, the result has `learningMs: 0` and `awayMs` = that gap. Otherwise `awayMs` is null.
  - `breakState(messages, sideChats, timings, enabled: boolean, now: number): BreakState`:

    ```ts
    interface BreakSuggestion {
      toolCallId: string; requestedBy: "window" | "learner";
      outcome: "pending" | "taken" | "skipped" | "ended";
      takenAt?: number; lengthMinutes?: number; breakMs?: number;
    }
    interface BreakState {
      window: { id: string; openedAtMs: number; escalated: boolean; noteInContext: boolean } | null; // openedAtMs in learning time
      latest: BreakSuggestion | null;   // the newest suggest_break call with an ok result
      skipsInRow: number;               // window-requested suggestions skipped since the last reset
      nextOpenAtMs: number | null;      // learning time at which the next window opens; null = none until a reset
    }
    ```

    Rules: a window is open from its `break-note` (`kind: "window"`) until an ok `suggest_break` result or a reset, whichever comes first. A suggestion's outcome is `taken` on a matching `break-taken`, `ended` on `break-ended`, and `skipped` on a matching `break-skipped` or on the first later main-transcript learner action that is not a break marker (choice 4). `nextOpenAtMs` is: `intervalMs − leadMs` after a reset or at the start; `skipLearningMs + reofferMs` after a window-requested skip; `null` when `skipsInRow ≥ 2` or `enabled` is false. `escalated` is true when a `kind: "escalation"` note exists for the window. `noteInContext` is false when the window's newest note (original or re-sent) sits before the model context start: the larger index of the newest `lesson-record` marker's `firstKeptMessageId` and the newest `compaction` marker's `firstKeptMessageId`.
  - `breakNotesFor(messages, sideChats, timings, enabled: boolean, now: number): LhMarkerMessage[]`: the notes due on a learner input at `now`, in this order:
    1. **away**, when `learningClock(…, now).awayMs` is not null and the latest suggestion isn't `taken`. Text below, with the gap formatted by `formatAway(ms)` (`"2 h 14 min"`, `"18 min"`);
    2. **window**, when `enabled`, teaching has started (`hasProbeDone`), no window is open, `latest` is not `pending` or `taken`, `nextOpenAtMs` isn't null, and learning time ≥ `nextOpenAtMs`;
    3. **re-sent window note** (same text and `windowId`), when a window is open and `noteInContext` is false;
    4. **escalation**, when a window is open, not escalated, and learning time ≥ `openedAtMs + escalateMs`.
  - `breakCountdown(takenAt: number, lengthMinutes: number, now: number): { label: string; over: boolean; progress: number }`: `"9:41"` while time remains, then `"+1:23"` with `over: true`; `progress` is elapsed / length, capped at 1.
- New tests: `tests/break-markers.test.ts`, `tests/break-clock.test.ts`, `tests/break-state.test.ts`.

**Note texts (confirmed).** They arrive on the user-role wire, so they use the bracket convention like `[Session note]`.
- Window: `[Session note] The learner has been learning for about {interval} minutes. At the next closed point, suggest a short break: say so in one line, then call suggest_break with requestedBy "window" and end your turn. A closed point is a node end (its check answered correctly, no repair pending) or, better, a unit end; if the current node is the last of its unit, wait for the unit end. Never break mid-step or during a repair.`
- Escalation: `[Session note] A break is overdue. Suggest it at the very next closed point, a node end included; don't hold out for the unit end.`
- Away: `[Session note] The learner is back after {away} away. If it helps, re-orient them in one line (where we are, what's next), then continue.`
- Back (the `break-ended` content): `[Session note] The learner is back from a {m:ss} break. Re-orient them in one line (where we are, what's next), then continue teaching.`

**Tests.**
- Clock: activity at 0, 10, 20 min and `now` at 25 → `learningMs` 25 min; a 12-min gap with the default length resets (the clock restarts at the returning action); a 9-min gap doesn't; the reply-end rule: a learner action at 0, a reply ending at 4, the next action at 13 → gap 9, no reset. A `subagent-steer` wake at 8 with a teacher reply at 8.5 doesn't end a gap that runs from 2 to 14. A side-chat user message at 7 does. A `break-ended` marker resets. `now` 15 min after the last activity gives `awayMs` 15 min and `learningMs` 0. An assistant message without `durationMs` ends at its `timestamp`. An old transcript (no break markers) whose last action is 3 days before `now` gives `awayMs` ≈ 3 days, and `breakNotesFor` returns only the away note.
- State: no window before 40 min; a window note at 41 and then an ok `suggest_break` closes it; `break-taken` → `taken`; a later `text` message without Take → `skipped`; two skips → `nextOpenAtMs` null; one skip at learning time 46 → `nextOpenAtMs` 66 min; a lesson-record marker whose kept boundary lies after the window note → `noteInContext: false`.
- `breakNotesFor`: window note exactly once across two inputs; escalation at opened + 20 and only once; a re-send after a cut; nothing while `enabled` is false except away; nothing before `probe_done` except away; away and window together, in that order.
- Markers: `toLlmMessages` carries `break-note` and `break-ended` as user text and drops `break-taken`/`break-skipped`; `nativeInputCause` values as listed; `reconstructRequestCause` of a transcript ending in `break-ended` is `"foreground"`.
- `breakCountdown(0, 10, 19_000)` → `"9:41"`; at 683 000 → `"+1:23"`, `over: true`, `progress: 1`.

---

## Part 3 — The `suggest_break` tool

**Goal.** The teacher's break tool, with its guards.

**Files.**
- New `src/agent/tools/breaks.ts`: `suggestBreakTool(ctx: BreakToolContext): Record<string, AgentTool<any>>`, where `BreakToolContext = { chatId: string; chatStore: ChatStore; breaks: () => { enabled: boolean; intervalMinutes: number; lengthMinutes: number }; now: () => number }`. The input schema is `{ requestedBy: "window" | "learner" }` (typebox, like the other tools). It's server-side (`serverExecute`, as in `src/agent/tools/probe.ts`). Checks, in order, for `requestedBy: "window"` only (choice 3; a learner request is never refused except by rule 4):
  1. no open window (`breakState(...).window === null`) → refusal R1;
  2. no teach-tagged call yet (`teachTags(messages).length === 0`) → R2;
  3. `hasUnresolvedQuestion(messages)` → R3.

  For both values:
  4. `latest.outcome` is `pending` or `taken` → R4.

  Success → result text OK1, `details: { ok: true, requestedBy }`. A refusal → `details: { ok: false }` with the refusal text as the result content.
- `src/agent/tools.ts` `createTeacherTools` (~l.450): add `...suggestBreakTool(ctx)`. `TeacherToolContext` gains `breaks` and `now`. `src/server/chat-handler.ts` (~l.765, ~l.778) passes `breaks: () => effectiveSettings().breaks` and `now: Date.now`.
- `src/agent/teacher-agent.ts` `CONVERSATION_TOOL_NAMES` (~l.62): add `"suggest_break"`.
- New tests: `tests/suggest-break-tool.test.ts`.

**Tool texts (confirmed).**
- Description: `Offer the learner a short break. Call it only at a closed point: when a [Session note] says a break is due, or whenever the learner asks for a break (requestedBy "learner"). First say it in one line of ordinary prose about the material (e.g. that the unit is closed and this is a good moment), then call this tool and end your turn. The learner chooses Take or Skip in the app; don't ask them again in prose.`
- OK1: `Break offered. End your turn now; the learner chooses in the app.`
- R1: `No break is due right now. Suggest a break only after a [Session note] says one is due, or when the learner asks (requestedBy "learner").`
- R2: `Teaching hasn't started yet. A due break waits for the first closed point in teaching.`
- R3: `A question is still open. Suggest the break after it is answered and the step is closed.`
- R4: `A break offer is already open.`

**Tests.** Each refusal fires in its condition, with exact text; a learner request passes with an open question and no window; a window request with an open window, a teach tag and no open question returns OK1 and `ok: true`; `createTeacherTools` contains `suggest_break`; the prober registry does not.

---

## Part 4 — Server wiring: notes, Take/Skip, Continue

**Goal.** Notes ride learner inputs; Take and Skip are silent appends; Continue composes a teacher turn.

**Files.**
- `src/server/chat-handler.ts` (~l.585, next to the units-note append): for a teaching chat (`record.kind !== "practice"`) and an input of a type listed in choice 8, append `breakNotesFor(afterInput, record.sideChats, breakTimings(effective.breaks), effective.breaks.enabled, Date.now())`.
- `src/core/input-events.ts`: `ChatInput` gains `{ type: "break-continue"; toolCallId: string }` (parsed like `retry-question`). `inputAppends` for it: the latest suggestion must be `taken` with that `toolCallId`, or `ChatInputError("No break is running.")`. The append is `newBreakEndedMessage(toolCallId, now − takenAt, <Back text>)`.
- New `app/api/chats/[id]/break/route.ts`: `POST { input: { type: "take" | "skip"; toolCallId: string } }`, following the dismiss route's shape (`app/api/chats/[id]/dismiss/route.ts`). 404 for an unknown chat. 409 `{ error: "A turn is running." }` while `isTurnRunning(id)`. 400 `{ error: "No break offer is open." }` unless the latest suggestion is `pending` with that `toolCallId`. Otherwise append `newBreakTakenMessage(toolCallId, effective.breaks.lengthMinutes)` or `newBreakSkippedMessage(toolCallId)`, save, `emit("record-changed", { chatId })`, and return `{ ok: true }`. On Take at a unit end, it then calls Part 5's `prepareUnitCutDuringBreak` without awaiting it.
- New tests: `tests/break-notes-handler.test.ts`, `tests/break-route.test.ts`, `tests/break-continue-input.test.ts`.

**Tests.** A learner `text` input at 41 min of learning carries one window note; an automatic `steers` wake at 41 min carries none; a practice chat never does; Take with the wrong id → 400; Take during a running turn → 409; Take then Skip → 400 (no longer pending); Take twice → the second gets 400 and the transcript holds one `break-taken`; changing `lengthMinutes` in settings after Take leaves the marker's saved `lengthMinutes` in the view; `break-continue` before Take → `ChatInputError`; after Take it appends `break-ended` whose content says the break length (`m:ss`) and its `breakMs`; the next `breakState` shows `ended` and a reset clock.

---

## Part 5 — Prepare the unit cut during a unit-end break

**Goal.** A break taken at a unit end builds the finished unit's lesson-record judgment while the learner is away. The cut at the move uses it when the span matches.

**Files.**
- `src/core/units.ts`: `atUnitEnd(tree: PlanTree, messages: readonly LhMessage[]): boolean` is true when the tree has units, a next unit exists, and every node of the current unit is visited or current.
- `src/server/unit-cut.ts`: extract the judgment step of `runUnitCut` (prompt build, fit check and fallback, summarizer call, parse and retry) into `computeLessonJudgment(deps, chatId, messages, tree, cur, k)`, which returns `{ judgment, usages } | "failed"` with no behaviour change. Add a module registry `preparedJudgments: Map<chatId, { spanKey: string; judgment: LessonJudgment; usages: … }>` and `spanKeyOf(messages, s, k, previousRecordId)`: the previous record id plus the ids of the non-marker messages in `[s, k)`, joined. `runUnitCut` uses (and deletes) a registry entry whose `spanKey` equals the real span's key instead of calling the summarizer; any other entry for the chat is deleted.
- New `src/server/break-cut-prep.ts`: `prepareUnitCutDuringBreak(deps: CompactionDeps, chatId: string): Promise<void>`. If `atUnitEnd`, compute the judgment as the cut would for the next unit, with `k` = the transcript length at the call, and store it under that span's key. Failures only log.
- New tests: `tests/break-cut-prep.test.ts`.

**Tests** (summarizer stubbed and counted). After a prepared span, a cut whose span equals it makes no summarizer call and writes the same judgment into the lesson record; a cut with one extra non-marker message in the span calls the summarizer and discards the entry; break markers between the preparation and the move don't break the match; `atUnitEnd` is false mid-unit, in the last unit, and without units; `runUnitCut` without a registry entry behaves exactly as before (one existing-behaviour assertion: the same marker fields for the same stubbed judgment).

---

## Part 6 — What the learner sees

**Goal.** The divider in the transcript, the countdown screen, the buttons.

**Files.**
- `src/core/view.ts`: an ok `suggest_break` tool call projects a part `{ type: "data-break", id: "br_<toolCallId>", data: { toolCallId, state: "offered" | "taken" | "skipped" | "ended", takenAt?, lengthMinutes?, breakMs? } }` from `breakState`'s suggestion view of that call. A refused call projects nothing. `projectMarker` (~l.454): the four break markers render nothing.
- New `components/break-divider.tsx`: `BreakDivider({ data, busy, onTake, onSkip })`, with the dashed-rule-plus-chip geometry of the prototype's divider and `data-testid="break-divider"`. Labels below. The buttons show only in `offered` and are disabled while `busy`.
- New `components/break-screen.tsx`: `BreakScreen({ takenAt, lengthMinutes, onContinue })`, a full-screen portal over the lesson (`data-testid="break-screen"`) with a ring and `breakCountdown` ticking every 250 ms, the advice line, and a `Continue lesson` button. Esc calls `onContinue`. There is no other way out.
- `components/chat.tsx`: render `data-break` parts with `BreakDivider`. While the newest `data-break` is `taken`, mount `BreakScreen`. Take/Skip POST to `/api/chats/<id>/break`; Continue posts `{ type: "break-continue", toolCallId }` through the existing chat input path.
- New tests: `tests/break-view.test.ts`, `tests/render-break-divider.test.tsx`, `tests/render-break-screen.test.tsx`.

**Learner copy (confirmed).**
- Offered chip: `Short break?` · button `Take {length} min` · button `Skip`.
- Skipped chip: `Break skipped`. Ended chip: `Break · {m:ss}`. Taken chip (under the screen): `On break`.
- Screen advice, before zero: `Stand up, move, look out of a window. Leave the phone. The lesson waits where you left it.`
- Screen advice, past zero: `Time's up. The lesson is waiting where you left it.`
- Button: `Continue lesson`.

**Tests.** The view emits one `data-break` per ok call, with the state following the markers (offered → taken → ended; offered → skipped by a later `text`). A refused call emits nothing. A `taken` part's `takenAt` and `lengthMinutes` come from the saved `break-taken` marker, so projecting the same saved messages again (a restart) gives the same values. The divider shows Take/Skip only when offered, disabled while busy. The screen shows `9:41` at 19 s and `+1:23` past zero, and Esc calls `onContinue` once.

---

## Part 7 — Teacher doctrine (prompt)

**Goal.** The teacher knows how breaks work.

**Files.**
- New `src/agent/prompts/teacher/45-breaks.md` (text below).
- New test: `tests/prompt-breaks-doctrine.test.ts` asserts that `composeInstructions("teacher")` contains `suggest_break` and `closed point`, and that the prober and practice prompts do not.

**Prompt text (confirmed).**

> ## Breaks
>
> The app keeps time; you pick the moment. When a [Session note] says a break is due, suggest it at the next closed point: a node end (its check answered correctly, no repair pending) or, better, a unit end. If the current node is the last of its unit, wait for the unit end; otherwise take the node end. Never mid-step, never during a repair, never with a question open.
>
> To suggest it, write one line about the material (the unit or step that just closed, and that this is a good moment), call `suggest_break`, and end your turn. Don't add advice on how to rest; the app shows that. If the learner asks for a break at any time, say yes in one line and call `suggest_break` with requestedBy "learner".
>
> When a note says the learner is back, re-orient them in one line (where we are, what's next) and continue. Don't re-teach what was closed before the break.

---

## Part 8 — Docs

`--no-tests-first`.

**Files.**
- `docs/architecture.md`: one section on the break flow (clock → window note → `suggest_break` → Take/Skip → screen → Continue → reset; cut preparation), pointing to `CONTEXT.md` and this plan.
- `docs/teaching-methodology.md`: one paragraph under 7a: breaks are logistics the system owns, placed at closed points, never forced.

---

## Review focus

The inputs and conditions most likely to bite a learner that no part's tests target directly:

1. **App restart mid-break.** The screen must reopen with the same countdown from the saved `takenAt` (Part 6 test).
2. **A reply without `durationMs`.** Legacy or deferred replies lack it, and the reply then ends at its `timestamp` (Part 2 test).
3. **A lesson opened from before this feature.** Old transcripts have no break markers. A long-idle one gets the away note and no window on its first new input (Part 2 test).
4. **Settings changed mid-lesson.** New values apply on the next learner input. A running countdown keeps the `lengthMinutes` saved at Take (Part 4 test).
5. **A double click on Take.** The second POST gets 400 and appends nothing (Part 4 test).

---

## Part 9 — Follow-ups decided after the build

**Goal.** Five choices the first build left open, settled by the maintainer on 2026-11-21, and one addition: the learner sees the learning clock in minutes below the composer. Nothing else changes.

**Files.**
- `src/core/breaks.ts`: `formatAway` and `breakCountdown`.
- `src/agent/tools.ts`: `TeacherToolContext.breaks` and `.now` become required; `createTeacherTools` loses its fallback (enabled / 45 / 5 / `Date.now`). Every place that builds a `TeacherToolContext` (including `src/agent/teacher-agent.ts` and the tests that call `createTeacherTools`, `createProberTools` or `practiceTools` with one) passes them; tests pass a fixed `BREAK_DEFAULTS`-based value and a fixed clock.
- `src/server/break-cut-prep.ts`: `prepareUnitCutDuringBreak` returns at once, without preparing, when `runningUnit(chatId)` (`src/server/compaction.ts`) is not `undefined`.
- `components/break-divider.tsx`: `BreakDivider` gains `error?: string`. In `offered` state with an error, one line under the buttons (`data-testid="break-divider-error"`) shows it; the buttons stay usable.
- `components/chat.tsx`: when the Take or Skip POST fails, the divider gets the server's `error` text from the JSON body (e.g. `"A turn is running."`, `"No break offer is open."`), or `"Couldn't reach the app. Try again."` when the request itself fails or the body has no `error`. The next Take or Skip click clears it.
- `src/core/breaks.ts`: new `learningMinutes(clock: LearningClock): number`: `0` when `clock.awayMs !== null` (a reset), else `floor(clock.learningMs / 60 000)`.
- `components/stats-bar.tsx`: `StatsBar` gains `learningMinutes?: number`. When defined, it renders `"<n> min"` in muted text (`data-testid="learning-minutes"`) directly before the dictation slot, after the session data. Undefined renders nothing (home, `/chat/new`, practice).
- `components/chat.tsx`: for a teaching chat (not practice) it passes `learningMinutes(learningClock(<native messages>, <side chats>, breakTimings(<resolved breaks settings>), Date.now()))` to `StatsBar`, recomputed every 15 s and on every transcript change. Shown whether breaks are enabled or not. Plain minutes, never hours.
- New tests: `tests/break-followups.test.ts`, `tests/render-break-divider-error.test.tsx`, `tests/render-learning-minutes.test.tsx`.

**Rules and examples.**
- `formatAway(ms)`: whole minutes `m = floor(ms / 60 000)`. From 24 h: days, then whole hours, leaving out a zero hours part. From 1 h to under 24 h: hours, then minutes, leaving out a zero minutes part. Under 1 h: minutes.
  - 18 min → `"18 min"`; 0 → `"0 min"`; 134 min → `"2 h 14 min"`; 120 min → `"2 h"`; 23 h 59 min → `"23 h 59 min"`; 24 h → `"1 d"`; 72 h → `"3 d"`; 74 h 30 min → `"3 d 2 h"`.
- `breakCountdown(takenAt, lengthMinutes, now)`: let `over = elapsed − total`. Not over while `over < 1000` ms: label is the remaining time `m:ss` rounded up, never below `"0:00"`. From `over ≥ 1000`: `over: true`, label `"+m:ss"` of `floor(over / 1000)`. `"+0:00"` never appears. `progress` unchanged (elapsed / total, capped at 1).
  - `(0, 10, 19 000)` → `"9:41"`, not over; `(0, 10, 600 000)` → `"0:00"`, not over, progress 1; `(0, 10, 600 999)` → `"0:00"`, not over; `(0, 10, 601 000)` → `"+0:01"`, over; `(0, 10, 683 000)` → `"+1:23"`, over.
- `learningMinutes`: learningMs 0 → 0; 38 min 59 s → 38; 72 min → 72 (never hours); any clock with `awayMs` set → 0.
- `prepareUnitCutDuringBreak` with a running unit cut for the chat: no summarizer call, no registry entry; without one, behaviour as in Part 5.

**Tests.** Every example above; `createTeacherTools` given `breaks` returning `{ enabled: true, intervalMinutes: 30, lengthMinutes: 7 }` and a fixed `now` makes `suggest_break`'s window checks use 30/7 and that clock; preparation skipped while `setRunningUnit(chatId, 2)` is set and done after it is cleared (summarizer stubbed and counted); `BreakDivider` offered with `error` renders the line and enabled buttons, without `error` renders no line, and in `taken` renders no line even with `error`; `StatsBar` with `learningMinutes={38}` renders `38 min` before the dictation slot's content, and without the prop renders no `learning-minutes` element.

---

## Part 10 — A long absence skips an open offer

**Goal.** A break offer still open when the learner goes away counts as skipped once the absence is reached: the server refuses Take/Skip for it, and the divider shows it as skipped (maintainer, 2026-11-21). Nothing else changes.

**Files.**
- `src/core/breaks.ts`, `breakState`: in the final away check (`activityEnd !== null && now − activityEnd ≥ timings.lengthMs`, ~l.254), a `latest` whose outcome is `pending` becomes `{ ...latest, outcome: "skipped" }`. `skipsInRow` and `nextOpenAtMs` are reset there as today (the away reset wins; this skip is not counted).
- `src/core/breaks.ts`: new `dividerState(state: "offered" | "taken" | "skipped" | "ended", away: boolean)`: `"skipped"` when `state === "offered"` and `away`, else `state`.
- `components/chat.tsx`: where the `data-break` part is rendered as `BreakDivider`, its state goes through `dividerState(data.state, away)`, with `away = learningClock(<native messages>, <side chats>, breakTimings(<break settings>), Date.now()).awayMs !== null`, computed next to `learningMinutesNow` on the same 15 s tick and transcript changes. For a practice chat `away` is `false`.
- New tests: `tests/break-away-skip.test.ts`.

**Rules and examples** (timings 45 / 10 min, one ok `suggest_break` result at 30 min of learning, no learner action after it).
- `breakState(…, now = activity end + 9 min 59 s).latest.outcome` → `"pending"`; at activity end + 10 min → `"skipped"`; `skipsInRow` → 0 either way after the away reset.
- With a `break-taken` marker for that call before the absence, the outcome stays `"taken"` at any `now`; with `break-ended`, `"ended"`.
- The break route (`app/api/chats/[id]/break/route.ts`), Take after the absence → 400 `{ error: "No break offer is open." }`.
- `dividerState("offered", true)` → `"skipped"`; `("offered", false)` → `"offered"`; `("taken", true)` → `"taken"`; `("ended", true)` → `"ended"`; `("skipped", false)` → `"skipped"`.

**Tests.** Every example above, `breakState` with a fixed clock and fixed message timestamps; the route case through the route handler as in `tests/break-route.test.ts`'s style, with new helpers (no reuse of its fixtures).

---

## Status per part

| Part | Status | Build id |
|---|---|---|
| 1 Break settings | green 2026-11-21 (run 20261121-130954-002-part-1; fix round 20261121-185249-002-part-1: settings route test) | - |
| 2 Markers and the learning clock | green 2026-11-21 (run 20261121-133958-002-part-2) | - |
| 3 The suggest_break tool | green 2026-11-21 (run 20261121-141612-002-part-3) | - |
| 4 Server wiring | green 2026-11-21 (run 20261121-162409-002-part-4 after the ladder's lock fix, first run 20261121-144624 stopped on the lock; Take wires prepareUnitCutDuringBreak in run 20261121-181154-002-part-4) | - |
| 5 Cut preparation | green 2026-11-21 (run 20261121-163542-002-part-5; fix round 20261121-190151-002-part-5: runUnitCut order restored) | - |
| 6 What the learner sees | green 2026-11-21 (run 20261121-170452-002-part-6) | - |
| 7 Teacher doctrine | green 2026-11-21 (run 20261121-174726-002-part-7) | - |
| 8 Docs | green 2026-11-21 (run 20261121-183939-002-part-8; first run 20261121-175943 stopped on the unwired Take call) | - |
| 9 Follow-ups | green 2026-11-21 (run 20261121-192430-002-part-9) | - |
| 10 Absence skips an open offer | green 2026-11-21 (run 20261121-224046-002-part-10) | - |
