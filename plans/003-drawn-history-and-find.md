# 003 — Drawn history and whole-session Find

Status: **approved** 2026-11-22.

## Starting a session on this plan

1. Until the line above says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill):
   `ladder queue --plan plans/003-drawn-history-and-find.md --step "Part 1" --step "Part 2" …`.
3. After each green part, update "Status per part" at the bottom.
4. Tests: new helpers and fixtures only; never reuse or edit existing test fixtures.

## What this changes

Opening a long session is slow (3.4 s to settle the largest lesson, 888 KB / 467 native messages), and almost all
of it is rendering every row through markdown and KaTeX twice, on the server and during hydration
(`research/load-time-measurement.md`). Reading and sending the data costs under 20 ms.

1. **Drawn history.** The browser still receives the whole session, but only the newest ~270 KB of it is drawn
   (≈ 1 s on the largest lesson). An **Earlier history** divider at the top offers **Show earlier** and **Show all**.
2. **Find covers the whole session** and moves into the header. An icon left of the Plan chip (and Mod+F) opens
   a dropdown with a live, newest-first list of hits. Hits in the earlier history draw it on demand.
3. **Fewer whole-record downloads.** The model picker and the coverage ring read small views instead of the whole
   record.

Glossary: root `CONTEXT.md`: **Learner input**, **Drawn history**, **Earlier history**, **Find**.
Decision record: the wayfinder map `.scratch/lesson-history/map.md` and its tickets (2026-11-22).
Research: `research/full-history-dependents.md`, `research/load-time-measurement.md`.

## Owner decisions (2026-11-22)

Drawn history:
1. Render only. The client keeps receiving the whole session; the cut is made only in rendering, both on the server
   and in the browser. Every whole-history fold (phase, plan chip and statuses, plugin questions, active problem,
   side chats, learning clock, deep links, plugin API history), the GET sync and the merge model stay unchanged.
2. Drawn history = the newest stored content up to a budget of about 270 KB, extended back so it starts right after a
   learner input (any learner input). The rest is earlier history.
3. No setting. A session within the budget is drawn whole. So is one whose earlier history would be under ¼ budget.
4. While a session stays open, new content is always drawn and nothing is un-drawn. The cut is made afresh on the next
   open or reload. The drawn start is anchored to a message id, so a GET re-read never draws the earlier history.
5. An "Earlier history" divider (that text only) with **Show earlier** (one more budget-step) and **Show all**.
   No auto-draw on scroll, no outline. The reading position stays put. When everything is drawn, the divider is gone.
6. A Find hit or a graph deep link into the earlier history extends the drawn history back to its target (one
   unbroken stretch). A deep link that opens a session draws back to its target right away. Arrival as today. A
   "Drawing earlier history…" status shows for slow draws. The way back is today's ↓ button.

Find:
7. One feature, named **Find**: the header icon and Mod+F open it. Today's bar under the header goes away.
8. It looks through the learner's messages, the teacher's prose, all cards (questions, checks and their answers,
   practice problems and solutions, plan blocks, plugin questions) and side-chat threads. Not: the teacher's thinking,
   compaction summaries, lesson records.
9. It never matches text not yet revealed to the learner (a pending check behind "Check your understanding", a
   practice problem's model solution before conclude). Text visible by expanding a card counts as revealed.
10. Case-insensitive; accents ignored (`uber` ↔ `über`, `e` ↔ `é`, `ß` ↔ `ss`, no ae/oe/ue); substring anywhere in a
    word; a multi-word query is an exact phrase.
11. Text as shown: Markdown syntax stripped, formulas and diagrams not searchable. Content plus unit-divider titles;
    no fixed UI labels or buttons, no phase or break dividers.
12. Dropdown under the icon (width `min(28rem, 90vw)`): field, counter, ↑/↓, ×, results list. Newest hit first, one
    row per occurrence; label line = who/what + unit, then a snippet with the hit marked.
13. Live while typing after a short pause; the newest hit is selected and scrolled to. ↓/Enter = down the list
    (older), ↑/Shift+Enter = toward the newest. Clicking a row jumps there. All drawn hits highlighted, selected one
    strongest.
14. Stays open while the learner clicks or scrolls the transcript; Esc, × or the icon close it. On close the highlights
    clear and the transcript stays at the hit. Reopening in the same session keeps query and position; changing
    sessions resets them.
15. Side-chat hits sit in the list by their own time; selecting one opens that side chat at the hit and scrolls the
    transcript to the message it hangs off.
16. Selecting a hit inside a collapsed, already-revealed card expands the card; it stays open.
17. One pure extractor from the stored messages produces all hits, labels and order; the page only places
    highlights (Nth match inside the hit's part, whole-part flash as fallback); parity tests per card kind; the
    session-markdown engine (`src/core/session-markdown.ts`) stays untouched.

Downloads:
18. The model picker reads `GET /api/chats/[id]?view=settings`, the coverage ring `?view=coverage` (also in its 2 s
    run poll, cadence unchanged). The session model's full re-read stays.

Taken by recommendation under the owner's standing preference for this effort ("go with recommendation for all"):
19. Agent delivery cards (sub-agent artifacts such as PDF-reader briefs) are searchable by their shown text, label
    **Agent**.
20. Labels: You, Teacher, Check (quiz, explain, probe, recall cards), Question (ask_user_question and plugin
    questions), Problem, Solution, Plan, Side chat, Agent, Unit (unit-divider titles).
21. "Slow draw" is decided by size, not a timer: the status shows when the content about to be drawn is at least
    `DRAW_STATUS_MIN = 82_944` characters (≈ 0.3 s by the measurement), painted before the draw starts.

## Part 1 — Drawn history core (pure)

New file `src/core/drawn-history.ts`, exported from `src/core/index.ts`.

Constants:
- `DRAWN_BUDGET = 276_480` (characters; 270 × 1024).
- `SMALL_REST = 69_120` (¼ budget).
- `DRAW_STATUS_MIN = 82_944`.

Size of a native message: `messageSize(m) = JSON.stringify(m).length`. Size of a range = sum over its messages.

**Boundaries.** `drawnBoundaries(messages: readonly LhMessage[]): number[]`, ascending. Index `0` is always a
boundary. Index `b` (1 ≤ b ≤ n − 1) is a boundary iff:
- `messages[b − 1]` is a learner input: `nativeInputCause(messages[b − 1], messages.slice(0, b − 1)) === "learner"`
  (`src/core/native-messages.ts`, the same definition the learning clock uses); and
- the boundary is clean: no tool call in `messages[0 … b − 1]` has its `toolResult` at an index ≥ b.
`b = n` is never a boundary (nothing would be drawn). Compute it in one forward pass. Keep a set of open call ids, and
pass the growing history to `nativeInputCause` without copying per message.

**Start for an end.** `drawnStartBefore(messages, end): number`. Let `B` = the boundaries `< end`. Pick the largest
`b ∈ B` with `size(messages[b … end)) ≥ DRAWN_BUDGET`; if there is none, `0`. Then if `size(messages[0 … b)) <
SMALL_REST`, return `0`. Returns `0` for `end = 0`.

Functions:
- `initialDrawnStart(messages)` = `drawnStartBefore(messages, messages.length)`.
- `showEarlierStart(messages, current)` = `drawnStartBefore(messages, current)` (one more budget-step above the current
  start; the small-rest rule applies again).
- `drawnStartForTarget(messages, targetIndex, current)` = `min(current, the largest boundary ≤ targetIndex)`.
  The result is `0` when no boundary is `≤ targetIndex`.
- `drawStatusNeeded(messages, from, to)` = `size(messages[from … to)) ≥ DRAW_STATUS_MIN`.

**Anchor.** The client stores the start as a message id (`null` = draw all):
- `startId(messages, index)` = `index === 0 ? null : messages[index].id`.
- `startIndex(messages, id)` = `id === null ? 0 : messages.findIndex(m => m.id === id)`. When the id is missing,
  return `initialDrawnStart(messages)`.

**Source on every view part.** `src/core/view.ts`, `projectView`. Every `LhViewPart` gets `sourceMessageId: string`,
the id of the native message it renders:
- text/reasoning/tool parts: the assistant message holding the block. Tool parts keep it after their result is
  applied. The existing `sourceMessageId` on question/plugin parts already has this meaning.
- user-row parts: the user message.
- marker-derived parts: the marker message (break, compaction, plan-block, artifacts).
- the unit-cut and compaction-cut dividers emitted before a kept message: that kept message.
The `LhViewPart` type gains `sourceMessageId?: string`. It is optional only for live streaming parts, which take the
streaming message's id.

**Filter.** `drawnPartFilter(messages, start): (part: LhViewPart) => boolean`. It returns `true` iff
`start === 0`, or the part's `sourceMessageId` has native index ≥ `start`, or the id is not found (unknown and live
parts are always drawn).

Tests (`tests/drawn-history.test.ts`, new fixture builders only):
- a session under budget → `initialDrawnStart = 0`;
- a session whose rest would be < `SMALL_REST` → `0`;
- the cut lands right after the learner input whose range first reaches the budget. Cover a typed message, a quiz
  answer `toolResult`, a `practice-thinking` marker and a learner steer (user message);
- never right after an automatic input (`subagent-steer`) or an assistant message;
- an unclean boundary is skipped: two question calls in one assistant message, the first answered, the second answered
  after more messages, so no boundary falls between the two answers;
- `showEarlierStart` steps once more and reaches `0` at the start;
- `drawnStartForTarget` for a target inside the drawn history (unchanged), in the earlier history, and before the
  first boundary (`0`);
- `startIndex` with a missing id falls back to `initialDrawnStart`;
- `projectView` sets `sourceMessageId` on every part kind listed above;
- `drawnPartFilter` keeps the parts of a row the cut falls inside only from the cut on.

## Part 2 — The session view draws only the drawn history

Files: `components/chat.tsx`, new `components/earlier-history-divider.tsx`, `components/session-navigation.tsx`,
`app/globals.css` (only if the status line needs a class).

1. `chat.tsx` holds `drawnStartId` state, initialised from `initialMessages` with
   `startId(native, initialDrawnStart(native))`. The initialiser runs during SSR too, so the server HTML contains only
   the drawn history. Each render derives `start = startIndex(native, drawnStartId)` from the current native history
   (`nativeMessages`), so appends, GET replaces and streaming never change what is drawn above.
2. The transcript loop keeps iterating the full projected `messages` with their indices (`phases[mi]`,
   `newestTurnFrom`, side entries and anchors stay indexed as today). A row whose parts are all filtered out renders
   `null`. Rows that are only drawn in part map over all `m.parts` with their original `pi` and render `null` for
   filtered parts. Rows without parts (user text rows) use the row's own source message.
3. When `start > 0`, `<EarlierHistoryDivider>` renders first inside the transcript column (inside the Find root, but
   marked `data-session-find-exclude`): a centred line with the text `Earlier history`, a button `Show earlier`
   (testid `earlier-show`) and a button `Show all` (testid `earlier-show-all`). Its geometry follows the unit-cut
   divider. It is absent when `start === 0`.
4. **Show earlier** sets `start` to `showEarlierStart(native, start)`; **Show all** to `0`. Before the state change,
   record the scroller's (`scrollContextRef.current.scrollRef.current`) `scrollHeight` and `scrollTop`. In a layout
   effect after the commit, call `scrollContextRef.current.stopScroll()` and set
   `scrollTop = oldTop + (newHeight − oldHeight)`.
5. **Draw to a message.** `chat.tsx` listens for the window event `lh:draw-to-message`
   (`detail: { messageId: string }`). It resolves the target's native index, computes
   `drawnStartForTarget(native, index, start)`, and applies it when smaller. When `drawStatusNeeded(native, newStart,
   start)` holds, it first renders a status line `Drawing earlier history…` (testid `drawing-earlier`) at the top of
   the transcript, waits two animation frames so it paints, then applies the new start. It dispatches
   `lh:drawn-to-message` (`detail: { messageId }`) after the commit. The position is not kept here: the caller scrolls
   to the target.
6. `components/session-navigation.tsx`: before looking up a hash target, if no element with that anchor exists,
   dispatch `lh:draw-to-message` for the hash's message id and run the existing retry loop afterwards. On a fresh open
   with a hash, this happens on mount, so the session draws back to the target right away.
7. A new session open (a different `chatId`) and a reload make the cut afresh (state initialiser). Nothing un-draws
   while the `Chat` instance lives.

Tests (`tests/drawn-history-view.test.tsx`, new helpers): with a fixture session over budget,
- the rendered transcript does not contain an early message's text, and contains the newest message's;
- the divider is present with its two buttons, and absent for a session under budget;
- `Show earlier` draws the next step and `Show all` draws everything;
- a GET replace with the same messages keeps the start;
- an appended message is drawn;
- `lh:draw-to-message` for an early message draws from its boundary and fires `lh:drawn-to-message`.

## Part 3 — Small views for the model picker and the coverage ring

1. `app/api/chats/[id]/route.ts`, `GET`, next to `?view=stats` and before the plugin-question reconcile:
   - `?view=settings` → `{ settings: chat.settings }`;
   - `?view=coverage` → `{ coverage: sessionCoverage(id) }`.
   Both return 404 `{ error: "Not found" }` for a missing chat, like `stats`.
2. `components/model-picker.tsx` (`readRecord`) fetches `/api/chats/${chatId}?view=settings`.
3. `components/extraction-coverage.tsx` (`fetchCoverage`) fetches `/api/chats/${chatId}?view=coverage`. The 2 s
   run poll is unchanged.

Tests (`tests/chat-small-views.test.ts`): each view returns only its field (no `messages`), and 404 for a missing
chat. The two components request the small view (fetch stub).

## Part 4 — Find text core (pure)

**Matching.** New `src/core/find-match.ts`; `src/core/session-find.ts` keeps exporting
`findSessionTextMatches(text, query)` with the new semantics and `stepSessionMatch` unchanged.
- Normalisation per character: Unicode NFD, drop combining marks (`\p{M}`), then `ß`/`ẞ` → `ss`, then lower case
  (`toLowerCase`). Keep a map from each normalised index back to its original UTF-16 range.
- Whitespace: every run of whitespace in text and query counts as one space; leading and trailing query whitespace is
  ignored; an empty query matches nothing.
- Matches are non-overlapping, scanned left to right, as original `{ start, end }` offsets. Substring anywhere; the
  whole query is one phrase.
- Examples: `uber` finds `über`, `Über`, `uber`; `über` finds `uber`; `strasse` finds `Straße`; `e` finds `é`;
  `ableit` finds `Produktableitung`; `kette regel` does not find `Kettenregel`; `zwei  wörter` finds `zwei
  Wörter` across a line break.

**Shown text.** New `src/core/find-text.ts`, `shownText(markdown: string): string[]`, one string per block.
- Parse with `unified` + `remark-parse` + `remark-gfm` + `remark-math` (all present in `node_modules`).
- Drop `math` and `inlineMath` nodes, `html` nodes, images, and fenced code whose language renders as a diagram or
  chart in the transcript. The implementer lists those languages from the markdown renderer config; at least
  `mermaid`.
- Keep link text (not the URL), inline code text and other code blocks' text.
- Blocks: paragraph, heading, list item, table cell, blockquote paragraph, code block. A phrase never spans two blocks.
- Learner-authored text (user messages, answers' free text, learner thinking) is plain text: no markdown parsing,
  whitespace runs collapsed, one block per line break.

**Units of text.** `findUnits(input): FindUnit[]`:
```ts
interface FindInput {
  native: readonly LhMessage[];
  view: readonly LhViewMessage[];
  sideThreads: readonly SideChatThread[];
  /** The pending question in the dock is visible (not behind the reveal gate, or revealed). */
  pendingQuestionVisible: boolean;
}
interface FindUnit {
  key: string;              // stable; equals the part's DOM `data-find-part`
  sourceMessageId: string;  // native message to draw to; for side chats the anchor message
  kind: "You" | "Teacher" | "Check" | "Question" | "Problem" | "Solution" | "Plan" | "Side chat" | "Agent" | "Unit";
  unit: { index: number; title: string } | null;
  time: number;             // the native message's timestamp; side-chat entries their own
  order: number;            // transcript order, for ties
  sideThreadId?: string; sideMessageId?: string;
  blocks: string[];
}
```
Per kind (only text the card shows; never UI labels):
- **You**: user text rows (typed messages, learner steers): the text. Practice thinking and plugin-problem
  submissions: the learner's text as the card shows it.
- **Teacher**: text parts of assistant messages (incl. `send_to_user` prose): `shownText`.
- **Check / Question** (answered cards, `components/answered-card.tsx`): `questionText`, `details` from the input,
  option labels and their descriptions, `other`, `text`, `readingThinking`, `thinking ?? note`, `explanation`,
  `committed`. Dismissed: `questionText` only. Plugin questions: the text their card shows.
- The **pending question in the dock** (key `dock`): its question text, details and options, only when
  `pendingQuestionVisible`.
- **Problem**: a practice problem pose card's statement and inputs as shown. Never the pose's `modelSolution`.
- **Solution**: a conclude card's verdict text, feedback and the revealed `modelSolution`.
- **Plan**: plan-block node titles and their shown descriptions.
- **Agent**: sub-agent artifact cards (`components/artifacts/steer-card.tsx`): title and shown body text.
- **Side chat**: every side-chat message (user and assistant) from `sideThreads`. The assistant's text through
  `shownText`.
- **Unit**: each unit-cut divider: `Unit N · title`.
- Excluded: reasoning parts, compaction summaries and their dividers, lesson records, phase and break dividers,
  malformed-question notices, retry lines.

`unit`: the unit a position falls in, from the lesson-record cuts (`firstKeptMessageId`) and the newest plan's unit
titles (`latestPlanUnits` in `src/core/view.ts`, exported for this). `null` when the plan has no units.

**Hits.** `findHits(units, query): FindHit[]` = for each unit and block, `findSessionTextMatches`. Each hit is
`{ unitKey, block, occurrence (Nth in the unit, 0-based), snippet: { before, match, after } }`. Snippets take up to 60
characters before and 90 after, collapsed whitespace, with `…` where cut. Order: newest first by `time`, ties by
`order` descending, then within a unit by position descending.

Tests (`tests/find-match.test.ts`, `tests/find-text.test.ts`): every example above; `shownText` drops math, mermaid,
html and URLs and keeps code and link text; each kind's fields, including:
- no `modelSolution` before conclude;
- no pending question when not visible;
- side-chat entries ordered by their own time;
- unit labels across a unit cut;
- newest-first ordering and occurrence numbering.

## Part 5 — Find in the header

Files: `components/session-find.tsx` (rewritten), `components/session-find-dom.ts`, `components/chat.tsx`,
`components/answered-card.tsx`, `components/side-thread.tsx` / `components/use-side-thread.ts`, the thinking block
component, `docs/keyboard.md`.

1. **Placement.** `SessionFind` renders a round icon button (`SearchIcon`, testid `find-open`, aria-label
   `Find in session`, title `Find in session (⌘F)`) in the session `TopBar` immediately left of the Plan chip. It
   shows in every session, also without a plan. The bar under the header is removed. The Mod+F handler opens the
   dropdown, and a second Mod+F focuses and selects the query.
2. **Dropdown** (testid `session-find`, `role="search"`). It is anchored under the icon, right-aligned, width
   `min(28rem, 90vw)`, max height `65vh`, and holds:
   - a field (aria-label `Find in session`, placeholder `Find in session…`);
   - a counter `i/N`;
   - ↑ (`Previous match (Shift+Enter)`), ↓ (`Next match (Enter)`) and × (`Close Find (Esc)`);
   - the results list (testid `find-results`).
   It stays open on transcript clicks and scrolls. Esc, × or the icon close it.
3. **Live.** The query is matched 200 ms after the last keystroke, over `findUnits` of the current native history,
   side threads and dock state. Units are recomputed when those inputs change. On a new query the newest hit is
   selected and shown.
4. **List rows** (testid `find-hit`): a label line with the kind, then ` · Unit N · title` when there is a unit; then
   the snippet with the match in `<mark>`. The selected row is highlighted and kept scrolled into view. With no hits:
   `No matches in this session.`
5. **Navigation.** ↓ and Enter select the next row down (older); ↑ and Shift+Enter the previous one; both wrap.
   Clicking a row selects it. Selecting a hit shows it:
   - If its `sourceMessageId` is in the earlier history, dispatch `lh:draw-to-message` and continue on
     `lh:drawn-to-message`. While waiting, the dropdown shows `Drawing earlier history…` under the field when the
     draw needs the status (Part 2 rule).
   - If it is in a collapsed, already-revealed part (the answered card's "Why" explanation, a collapsed thinking
     block), dispatch `lh:find-reveal` (`detail: { key, field }`). The card opens that section and keeps it open.
   - A side-chat hit opens that side thread through the existing open API at the hit's message, and also scrolls the
     transcript to the anchor message.
   - Highlight: in the element `[data-find-part="<key>"]` (side chat: the side-thread message element), run
     `findSessionTextMatches` over its displayed text runs (`session-find-dom.ts`) and take the occurrence-th match.
     Scroll it in with `scrollSessionTarget`. If that match doesn't exist, flash the element with
     `lh-source-highlight` for 2 s (as deep links do).
6. **Highlights.** All hits whose part is drawn get the `lh-session-find` highlight, the selected one
   `lh-session-find-active` (existing CSS highlight names).
7. **Close and reopen.** Close clears the highlights and leaves the scroll and drawn history as they are. Reopening
   keeps query and selected hit; a different session (new `Chat`) starts empty.
8. **DOM keys.** Every rendered part with Find text gets `data-find-part={key}`, the same key `findUnits` produces:
   transcript parts, the dock question and side-thread messages.
9. `docs/keyboard.md`, Find (Mod+F): rewrite to the new behaviour (header dropdown, whole session, newest first,
   ↓/Enter older, ↑/Shift+Enter newer, Esc closes).

Tests (`tests/session-find-header.test.tsx`, new helpers):
- the icon sits left of the Plan chip, and the old bar testid no longer renders;
- typing (after the pause) lists hits newest first with labels;
- Enter selects older and Shift+Enter newer, with wrap;
- a hit in the earlier history dispatches `lh:draw-to-message`;
- a hit in a collapsed explanation dispatches `lh:find-reveal`;
- Esc closes and clears the highlights; reopening keeps the query.

## Part 6 — Parity tests per card kind

`tests/find-parity.test.tsx`. For each kind in Part 4, render the real component from a fixture message and compute
its `findUnits`. Assert that, for three sample queries per kind (one word, one phrase, one with an umlaut), the hit
count from the extractor equals the count `findSessionTextMatches` finds in the rendered element's displayed text runs
(`[data-find-part]`). A card change that breaks parity fails this test. No production code changes in this part unless
a parity test exposes a mismatch, which is then fixed in the extractor.

## Status per part

| Part | Status | Build |
|---|---|---|
| 1 Drawn history core | open | |
| 2 Session view draws the drawn history | open | |
| 3 Small views | open | |
| 4 Find text core | open | |
| 5 Find in the header | open | |
| 6 Parity tests | open | |
