# What in the session view reads the full message list

**Question.** Which client-side features of the session (chat) view read the
whole native message list today, and what would break or change if the client
held only the most recent messages (say the last 50–100)? This feeds a later
design decision about loading only the recent part of a long session when it
opens, plus keyword search over the full transcript.

**Scope.** Read-only survey of commit `4669f43f` (tip of `feat/antigravity-cli`,
2026-11-22, which includes the plan-002 learning breaks). All references are
`file:line` at that commit. Nothing here is a design proposal. The "server could
supply" column only says whether a server-side fold already exists or could
exist.

Legend for **Needs**:

- **Recent**: reads only the tail, so a window that holds the newest turn is enough.
- **Anchor**: needs history back to some earlier event (newest plan result, newest
  problem pose, start of the current side segment or learning run). That event can
  be arbitrarily old.
- **Full**: a fold from message 0, or a lookup of any message by id.

---

## 1. How the list gets to the client today

- **SSR seed.** `app/chat/[id]/page.tsx:16` `getChat(id)` → `:31`
  `initialMessages={chat.messages}` (every native message).
- **Model state.** `components/session.ts:36` → `SessionModel`
  (`components/session-core.ts:336-352`): `base` = the record,
  `tail` = optimistic appends plus the streaming turn. `nativeHistory()`
  (`session-core.ts:361-366`) concatenates `base + tail`.
- **View.** `getState()` (`session-core.ts:368-397`) runs `projectView(messages, live)`
  (`:384`), `measuredContextTokens` (`:388`) and `failedResponseAtEnd` (`:374`) over the
  **whole** list on **every** model change, including every streamed wire event
  (`applyWireEvent` → `mutate` → `onChange`, `:609-724`). It exposes three lists:
  `messages` (projected view), `nativeMessages` (base+tail) and
  `canonicalMessages` (base only).
- **GET `/api/chats/[id]`** (`app/api/chats/[id]/route.ts:4-52`) serves
  `messages: chat.messages` verbatim (`:42`). It already precomputes some
  fields server-side: `pluginQuestionAvailability` (`:43`, gated on
  `pendingPluginQuestionOf(chat.messages)` `:16`), `pluginProblemAvailability`
  (`:44`, gated on `activeProblemOf` `:23`), `pricing`, `turnInFlight`,
  `turnError`, `compacting` and `coverage` (`:45-50`). There is a precedent for a
  lightweight view: `?view=stats` (`:6-11`) returns only `turns` and `pricing`.
- **Reattach stream** `app/api/chats/[id]/stream/route.ts` replays only the
  running turn's event log, never history.

### GET re-fetch and how it merges (`SessionModel.readRecord`, `session-core.ts:453-481`)

Three adoption modes:

| Mode | Effect | Callers |
|---|---|---|
| `replace` (default) | `replaceMessages` (`:1207-1228`): **`this.base = record`**, `tail = []` | `syncFromServer` (`chat.tsx:1229-1242`), fired from: reattach settled (`:1249`), stream error (`:1440-1459`), job settle when idle (`:1517`), `turn-settled` when idle (`:1590-1618`), `record-changed` (`:1628-1638`). Also `reconcile()` (`session-core.ts:496-537`), which runs after every finished consume (`:767`), on plugin identity changes (`chat.tsx:576-580`), after dismissals (`session-core.ts:562`) and after a break Take/Skip (`chat.tsx:1181`). Also the `resumeStream` refetch-first path (`session-core.ts:838-850`) and the answer-recovery read (`:914`) |
| `append` | `appendMessages` (`:1242-1255`): accepted **only if every current base id is still in the record** (`baseAbsorbed`, `:1246-1247`). Swaps `base`, drops tail entries the record has absorbed (`absorbed()`, `:175-208`, scans the whole record by content) | `adoptAppendOnly` (`chat.tsx:1264-1270`): the turn-start window at 400/1000/2000 ms (`:1292-1296`) and job settles during a busy turn (`:1515`) |
| `none` | read only | stream-error liveness check (`chat.tsx:1448`) |

Mid-turn, streamed messages land in `tail` by slot or by id (`session-core.ts:624-690`).
Steer and marker upserts are skipped when `base` already carries the id (`:643`).

**Consequence for windowing.** The merge model assumes the GET returns the
**complete** record. `replace` would throw away any older pages the client had
loaded. `append` would reject every response once the window slides, because the
oldest base id would no longer be in the record. It returns `undefined`, so
mid-turn adoption of steers and artifacts would silently stop.

---

## 2. Feature table

| # | Feature | Reads (file:line) | What it derives | Needs | Server could supply it as a field? |
|---|---|---|---|---|---|
| 1 | **Transcript grouping** (`projectView`) | `src/core/view.ts:155-374`; `findToolPart` `:170-191`; `applyResultTo` `:456-481` | Assistant groups, and toolResults paired **backward** to their call ("even turns later", `:17-20`). A result whose call is not in the list is dropped silently | Recent, **if** the window starts at a clean boundary. Answers and results at the window's top lose their card (`AnsweredCard`, `chat.tsx:2061-2065`) when the call is outside the window | Server could pick a window start that never splits a call from its result |
| 2 | **Phase chip** | `chat.tsx:692` `phaseTimeline(messages)`; chip `:1830`; dock `:2185`; plugin context `:1671` | Linear fold from index 0 that **starts at `"probe"`** (`src/core/phases.ts:129-137`). Moves to plan on `probe_done`, to teach on the first node-tagged quiz/explain | **Full**: `probe_done` sits at session start. A window would show "Probe" in a teaching session | Yes. A native fold already exists: `phaseAt3Lh` (`phases.ts:148-179`). The server could send the current phase plus the phase as of the window start, so the client folds the live tail on top |
| 3 | **Phase arc dividers** | Planning: `data-probe-handoff` marker rendered in place (`chat.tsx:1857-1866`). Teaching: `mi > 0 && phases[mi]==="teach" && phases[mi-1]!=="teach"` + `teachStepIndex` (`chat.tsx:1943-1949`, `:1990-1996`; `phases.ts:100-121`) | Exactly one teach divider at the flip | **Full** (same fold). Uses the **position** `mi > 0` and `phases[mi-1]` | Same seed as #2, or a `teachSeamMessageId` |
| 4 | **Teach-check reveal gate** (`requiresReveal`) | `chat.tsx:650` `phaseAt3(messages)` | Collapses a pending teach check behind "Check your understanding" | **Full**. A window that loses the phase opens teach checks **uncollapsed** (silent behavior change) | Same as #2 |
| 5 | **Plan chip, marginalia, popup** | Chip `chat.tsx:1351` `latestTree(messages)` (`components/plan-block.tsx:593-605`). Gate `:1321` `planExists` (`components/plan-window.tsx:41-44`). Marginalia `chat.tsx:2179` → `derivePlanStatuses` (`plan-window.tsx:46-52`; `src/core/contracts/plan.ts:90-111`). Popup `chat.tsx:2311` (`plan-block.tsx:628-644`) | Newest `tool-plan_*` result's tree. Statuses: `current` = last tagged node, `visited` = **every earlier tagged run** | Tree: **Anchor** (newest plan result, usually early in the lesson). Statuses: **Full** (`visited` needs every teach tag). A window would hide the chip and marginalia entirely, or show wrong statuses | Yes. Native folds exist: `derivePlanStatusesLh` (`plan.ts:143-154`), `teachTags` (`src/core/units.ts:13-32`) |
| 6 | **Plan units in popup** | `plan-block.tsx:632-637` `finishedUnitIds`, `currentUnitIndex` over `nativeMessages` | Finished units muted, current unit emphasized | `currentUnitIndex` is **Full** (max over all teach tags, `units.ts:40-48`). `newestLessonRecord` requires the record's `firstKeptMessageId` to be **present** in the list (`units.ts:50-60`), otherwise it returns `[]` | Yes (same native functions) |
| 7 | **Plan blocks in transcript** | `view.ts:607-616` splices the marker into the **preceding** assistant group after the last successful `plan_init` | Frozen snapshot card | Recent. Dropped silently if that group is outside the window | Not needed |
| 8 | **Pending built-in question / dock** | `chat.tsx:584` `findPendingToolCall(messages, pendingQuestionOf(nativeMessages))`; `:585` `malformedQuestionsOf`; `session-core.ts:893`, `:924`, `:1124`, `:1192` | `questionCallsOf` looks at the **newest assistant only** (`src/core/native-messages.ts:941-960`) | Recent. Exception: `pendingQuestionOf` counts the call id across **all** history to build a stable draft key for legacy duplicate ids (`native-messages.ts:908-922`) | Possible, but the tail is enough except for legacy duplicate-id keys |
| 9 | **Pending plugin question** (`pendingPluginQuestionOf`) | `chat.tsx:570-574` (over `canonicalMessages`); `session-core.ts:340` (constructor sets `syncing`), `:554`, `:881-892` (send gate), `:1123`, `:1221`; `needsContinuation` `native-messages.ts:1121` | `scanPluginQuestionCalls` (`native-messages.ts:862-880`) scans **every** assistant message, newest first: "saved plugin authority survives later assistants" (`:857`). Each call checks `messages.slice(mi+1)` for its answer (`:872`) | **Full**. An unanswered plugin question older than the window would lose dock ownership: the composer reappears, and the client send gate (`session-core.ts:881-886`) allows sends that the server's own fold rejects | Yes. The route already runs it (`route.ts:16`). It could send the snapshot and occurrence, not just availability |
| 10 | **Active problem** (`activeProblemOf`) | `chat.tsx:574`, `:595-596`, `:762`, `:2172`; `session-core.ts:888-892`, `:909`, `:1214`; scan `native-messages.ts:630-662` | Newest **clean** problem pose not freed by a later conclude or dismissal | **Anchor**: the newest pose plus its ack. A long practice exchange of thinking and nudges could push the pose out of the window | Yes. The route already runs it (`route.ts:23`) |
| 11 | **Practice "Next" readiness** | `chat.tsx:1201-1212` `nextReady`: `nativeMessages.some(... practiceProblemForCall ...)` | "At least one problem has **ever** been posed" | **Full** (semantically) | Yes: a boolean |
| 12 | **Conclude reveal / problem data** | `view.ts:340-344` `modelSolutionForConclude` / `problemInputForConclude` (`native-messages.ts:570-616`); `pluginProblemForCall` `view.ts:314`; `pluginProblemById` `chat.tsx:1901` (`src/core/plugin-problems.ts:230-238`) | Walks **back** from a conclude or submission to its pose | Anchor (pose ≤ the conclude) | Could be joined server-side, or the window start snapped to the pose |
| 13 | **Break divider / break screen** | `view.ts:266-270`, `:304`, `:378-397` `breakPartData(messages, messages.indexOf(m))` → `breakState(messages.slice(0,end), …)` (`src/core/breaks.ts:177-271`); `chat.tsx:1188-1190` `newestBreak` from the view; screen `:2328-2334`; divider `:1886-1897` with `dividerState(…, breakAway)` | Outcome of each `suggest_break` (offered/taken/skipped/ended), read from the markers **after** it | Recent, if the call's result is in the window. **Positional** (`indexOf`, `slice(0,…)`) and quadratic in the number of breaks | Yes (`breakState` is pure) |
| 14 | **Learning clock** (minutes in stats bar, "away") | `chat.tsx:1152-1166` `learningClock(nativeMessages, sideThread.threads, …)` (`breaks.ts:161-172`), recomputed on every transcript change plus every 15 s; `StatsBar` `components/stats-bar.tsx:206-208` | `replayClock` (`breaks.ts:111-159`) replays **from index 0**. `startedAt` = first learner action of the current run. `trigger` state carries across messages. `causeAt` re-slices history per toolResult (`breaks.ts:84-87` → `nativeInputCause`, `native-messages.ts:1064-1088`, whose answer branch scans all history `:1084`) | **Anchor** (start of the current learning run). A window starting mid-run **under-reports** minutes, and the carried `trigger` is lost. Also O(n²) per streamed event | Yes: send `{startedAt, activityEnd}` and the client computes `now − startedAt`. `breakNotesFor` is already server-only |
| 15 | **Unit-cut dividers** (lesson-record) | `view.ts:202-233`; titles `latestPlanUnits` (`view.ts:143-151`) | One divider per lesson-record **before its `firstKeptMessageId`**. Title = unit from the **newest plan tool result** | Divider: Recent (the kept message precedes its marker; if the kept message is outside the window the divider is just absent). Title: **Anchor/Full** (the plan result is old). It falls back to the raw `currentUnitId` (`:228`) | Yes: put the title and index into the divider data server-side |
| 16 | **Lesson-record markers** | `projectMarker` `view.ts:584-587` renders nothing; `nativeInputCause` treats them as neutral | (model-facing only) | n/a | n/a |
| 17 | **Compaction summaries** | Cut divider `view.ts:198`, `:235-247` (`activeCompactionOf`, `src/core/compaction.ts:354-367`); moment divider `view.ts:588-605`; `contextTokens` stops at the cut (`src/core/context-usage.ts:10-29`) | Newest compaction marker plus a divider before its kept message | Recent (the marker is appended at the tail when it happens). The cut divider is absent if the kept message is outside the window | Not needed |
| 18 | **Side chats** | `chat.tsx:367` `sideEntryPoints(nativeMessages, messages)`; `:1008` `useSideThread(chatId, nativeMessages)`; `:1024-1034`; `components/use-side-thread.ts:153-160`, `:185`, `:210-216` | `scanSideSegments` (`src/core/side-chat.ts:82-97`): segment id = **first assistant after the last learner input**. Plugin submissions resolve via `activeProblemOf(messages.slice(0,index))` (`side-chat.ts:72-80`). Threads load separately from `/api/chats/[id]/side-chats` (`use-side-thread.ts:93`) | **Anchor** (segment start, and the pose for plugin submissions). A window starting **mid-segment** mints a different segment id: entry buttons show "no history", and the thread lookup misses. The server re-resolves against the full record (`src/server/side-chat.ts:135`), so writes stay correct but the client view diverges | Yes: a segment id per message, or a window start snapped to a segment boundary |
| 19 | **Steering** | `session-core.ts:248-254` `visibleQueuedSteers` (ids in messages); `chat.tsx:1672`, `:2194`; upsert guard `session-core.ts:643` | Queued line disappears when the steer's id lands | Recent | Not needed |
| 20 | **Coverage ring** | `components/extraction-coverage.tsx:47-56` fetches the **full** `GET /api/chats/[id]` and keeps only `coverage`; re-fetched on refresh (`:273-279`) and **every 2 s while a run is in flight** (`:283-292`, `:147-150`) | Nothing from messages client-side; `sessionCoverage` is server-side (`src/server/chats.ts:209-230`) | None (no client dependency) | Already server-side. Only the transport is wasteful: it downloads the whole transcript to read one field. A `?view=coverage` like `?view=stats` would fix that |
| 21 | **Model picker** (adjacent) | `components/model-picker.tsx:61-66` fetches the **full** `GET /api/chats/[id]` to read `settings` | n/a | None | Same transport issue |
| 22 | **Graph deep links** | `src/core/session-navigation.ts:6-47` (`messageAnchorId`, `messageIdFromHash`, `firstSourceTextParts`); anchors placed `chat.tsx:365`, `:2017-2023`; arrival `components/session-navigation.tsx` (DOM `getElementById`, retries 300×64 ms then gives up); `propositionSessionHref` links the **first recorded** message of a node (`session-navigation.ts:21-26`); citation "go to source" `components/citation-source.ts:80-101` (DOM-only) | DOM anchor per native teacher message | **Full**: any message id must be reachable, and links deliberately point at the *first* mention (old). A message outside the window is "missing" | Needs a "load around message id" read. `firstSourceTextParts` itself works on any window |
| 23 | **Session find** (Ctrl-F bar) | `components/session-find.tsx`; `components/session-find-dom.ts:119-` | Searches **rendered DOM only** | n/a (today it finds everything only because everything is rendered) | Full-transcript keyword search must be server-side. No transcript search endpoint exists (`app/api/search` is the web-search engine status) |
| 24 | **Markdown export** | `app/api/chats/[id]/markdown/route.ts:26-37` → `sessionMarkdown(record.messages)` (`src/core/session-markdown.ts:226-238`); linked from `components/sidebar.tsx:1099` | Whole session | Server-side, **unaffected**. The client `ConversationDownload` (`components/ai-elements/conversation.tsx:132`) is unused | n/a |
| 25 | **Continuation / retry / error banner** | `chat.tsx:566` `continueIfOwed(initialMessages)`, `:1241`; `needsContinuation` `native-messages.ts:1119-` (tail, plus a full plugin-question scan); `endsInFailedTurn` `chat.tsx:1126`; `failedResponseAtEnd` `session-core.ts:374` (`src/core/input-events.ts:422-437`) | Tail state | Recent (except the plugin scan, see #9) | — |
| 26 | **Opening prompt** | `chat.tsx:877-878`, `initialPromptOwed` `:2410-2413` | "No user/assistant message yet" | Recent in practice | — |
| 27 | **Context meter** | `contextTokens` `session-core.ts:388`; `cliContextWindowOf` `chat.tsx:2188` (`native-messages.ts:123-133`) | Newest measured assistant, stopping at a compaction cut | Recent | — |
| 28 | **Plugin view / submission context** | `chat.tsx:353` `attempt.prepare(input, nativeMessages)`; `:1670` `messages: nativeMessages, transcript: messages` | Hands plugins the client's list | Whatever the client holds. This is a **documented plugin API contract**: "current browser history" (`src/core/plugin-submissions.ts:60-61`; `docs/plugin-api/plugin-view-context.md:225-238`) | A windowed client changes what third-party plugins see |
| 29 | **Scroll to bottom / anchor scroll** | `Conversation initial="instant"` `chat.tsx:1837` (use-stick-to-bottom); dock scroll logic `chat.tsx:2602-2962`; older rows get `content-visibility:auto` (`app/globals.css:720-723`) via `newestLearnerTurnFrom` (`components/transcript-rows.ts:9-12`, `chat.tsx:1962`, `:1982`) | Bottom-follow; virtualization-lite for rows older than the newest learner turn | Recent. Nothing handles **prepending** older messages (no scroll-position compensation). The React key fallback `m-${mi}` (`chat.tsx:1852` ff.) is positional and would remount rows on prepend | — |
| 30 | **Graph-context card** | `view.ts:486-495` ("ABOVE the first user message"); comment `chat.tsx:2402-2408` (marker is `message[0]`) | Session-start card | Assumes the session start is loaded. With a window it simply isn't shown | — |
| 31 | **Stats (turns/pricing)** | `session-core.ts:485-493` `?view=stats`; `chat.tsx:1371-1389` | Server-side already | None | Already separate |

---

## 3. Code that indexes by position or assumes `messages[0]` is the session start

- `phaseTimeline` / `phaseAt3` start at `"probe"` from index 0 (`phases.ts:50-57`,
  `:129-137`). The teach divider uses `mi > 0` and `phases[mi-1]` (`chat.tsx:1943-1949`,
  `:1990-1996`).
- `breakPartData(messages, messages.indexOf(m))` plus `messages.slice(0, end)`
  (`view.ts:268`, `:383-397`). `replayClock` folds from `i = 0` (`breaks.ts:137-157`).
  `causeAt` uses `messages.slice(0, i)` (`breaks.ts:84-87`). `keptIndex` falls back to `0` when
  the kept id is missing (`breaks.ts:282-290`; server-side `breakNotesFor`).
- `sidePluginSubmission` uses `activeProblemOf(messages.slice(0, index))` (`side-chat.ts:77`).
  `scanSideSegments` folds from index 0 (`side-chat.ts:82-97`).
- `scanPluginQuestionCalls` uses `messages.slice(mi + 1)` (`native-messages.ts:872`), and
  `questionCallsOf` uses `messages.slice(mi + 1)` (`:945`). Both are relative and fine on a
  window except for the history requirement in #9.
- The graph-context marker is assumed to be `message[0]` (`chat.tsx:2402-2408`;
  `view.ts:486-495`).
- `newestLessonRecord` requires `firstKeptMessageId` to exist in the list
  (`units.ts:50-60`). `keptIndexFor` returns `-1` → "render everything" (`compaction.ts:372-378`).
- React key fallback `m-${mi}` is positional (`chat.tsx` transcript map, from `:1849`).
- `isLastPart = mi === messages.length - 1` (`chat.tsx:1987`) is tail-relative, so it is fine.
- `appendMessages` requires the record to be a superset of `base` (`session-core.ts:1245-1247`).
  `replaceMessages` assumes the record *is* the whole history (`:1211`).

---

## 4. Riskiest dependencies (most likely to break silently)

1. **Record adoption assumes a complete record.** `replace` sets `base = record`
   on every sync (turn-settled, record-changed, job settle, every `reconcile()`
   after a stream ends). `append` refuses any response that is missing a base id.
   A windowed GET would discard older loaded pages on each sync, and mid-turn
   append adoption would stop working without an error
   (`session-core.ts:1207-1255`; callers in `chat.tsx:1229-1638`).
2. **The phase fold starts at "probe" from index 0.** A window loses the phase
   chip, the teach divider and the teach-check reveal gate. A teaching session
   would show "Probe", and checks would open uncollapsed (`phases.ts:129-137`;
   `chat.tsx:650`, `:692`, `:1830`).
3. **Plan tree and statuses** come from the newest `plan_*` result plus every
   teach tag. Chip, marginalia and popup would vanish or mis-mark nodes. Unit-cut
   titles degrade to raw ids (`plan-block.tsx:593`; `plan.ts:90-111`; `view.ts:143-151`).
4. **Plugin-question authority never expires.** An old unanswered plugin question
   outside the window drops dock ownership and opens the client send gate, while
   the server still enforces it (`native-messages.ts:857-885`; `session-core.ts:881-886`).
5. **Plugin API contract.** `PluginSessionViewContext.messages` and
   `PluginSubmissionContext.messages` are documented as the browser's history.
   Windowing changes what plugins see (`chat.tsx:353`, `:1670`;
   `docs/plugin-api/plugin-view-context.md:225-238`).
6. **Learning clock and side-chat segment ids** fold from the start of the
   current run or segment, which can lie outside a fixed-size window. Minutes are
   under-counted, and side-chat buttons and thread lookups mis-key
   (`breaks.ts:111-172`; `side-chat.ts:82-101`).
7. **Deep links and citations** jump to DOM ids. Graph links deliberately target
   a node's *first* mention, so they will often point outside a recent window
   (`session-navigation.ts:21-26`; `components/session-navigation.tsx`;
   `citation-source.ts:80-101`).
8. **Results whose call lies outside the window** are dropped from the view
   (answered cards missing at the window top) unless the window start is snapped
   to a call/result boundary (`view.ts:170-191`, `:456-481`).

## 5. Side observations relevant to the decision

- **Native server-side folds already exist** for most of the full-history
  derivations: `phaseAt3Lh`, `derivePlanStatusesLh`, `teachTags`,
  `currentUnitIndex`, `finishedUnitIds`, `pendingPluginQuestionOf`,
  `activeProblemOf`, `learningClock` and `breakState`. The GET route already
  precomputes availability fields from two of them.
- **Live updates matter.** Phase flips, a new `plan_init` tree, teach tags and
  break offers arrive *mid-turn* through the streamed tail. A server-supplied
  final value goes stale until the next sync, unless it is shaped as a seed
  ("state as of the window start") that the client keeps folding over its window.
- **Per-event cost today.** `projectView`, `phaseTimeline`, `sideEntryPoints`,
  `firstSourceTextParts`, `latestTree`/`planExists`, `pluginQuestionCallsOf` and
  `learningClock` (O(n²) through `causeAt`) all rerun over the full list on every
  streamed event (`session-core.ts:368-397`; `chat.tsx:365-367`, `:692`,
  `:1152-1166`, `:1321`, `:1351`).
- **Two surfaces download the whole transcript for one field:** the coverage ring
  (re-fetched every 2 s during extraction) and the model picker
  (`extraction-coverage.tsx:47-56`, `:283-292`; `model-picker.tsx:61-66`).
- **Session find is DOM-only.** Full-transcript keyword search needs a new server
  endpoint. Markdown export is already server-side over the full record and is
  unaffected.

## Sources

All primary, read at `4669f43f`: `app/chat/[id]/page.tsx`,
`app/api/chats/[id]/route.ts`, `app/api/chats/[id]/stream/route.ts`,
`app/api/chats/[id]/markdown/route.ts`, `components/chat.tsx`,
`components/session.ts`, `components/session-core.ts`,
`components/use-side-thread.ts`, `components/plan-block.tsx`,
`components/plan-window.tsx`, `components/transcript-rows.ts`,
`components/session-navigation.tsx`, `components/session-find.tsx`,
`components/session-find-dom.ts`, `components/citation-source.ts`,
`components/extraction-coverage.tsx`, `components/model-picker.tsx`,
`components/stats-bar.tsx`, `components/ai-elements/conversation.tsx`,
`app/globals.css`, `src/core/view.ts`, `src/core/phases.ts`,
`src/core/side-chat.ts`, `src/core/session-navigation.ts`,
`src/core/native-messages.ts`, `src/core/breaks.ts`, `src/core/units.ts`,
`src/core/compaction.ts`, `src/core/context-usage.ts`,
`src/core/input-events.ts`, `src/core/plugin-problems.ts`,
`src/core/plugin-submissions.ts`, `src/core/contracts/plan.ts`,
`src/server/chats.ts`, `src/server/side-chat.ts`,
`docs/plugin-api/plugin-view-context.md`.
