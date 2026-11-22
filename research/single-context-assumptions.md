# Research: what assumes one conversation = one model context

Wayfinder ticket: *Research: what assumes one conversation = one model context.*
Scope: read-only inventory of the LearnHarness source at commit `37ec55e`
(branch `research/single-context-assumptions`). It lists every part of the app
that treats one `ChatRecord` as one model context, so a later decision can weigh
splitting a teaching lesson into one fresh model context per plan node.

Two candidate shapes are evaluated:

- **(a) Child conversations.** Each plan node runs in its own `ChatRecord`,
  linked to a parent lesson record.
- **(b) Segments.** One `ChatRecord` holds the whole lesson, but the
  model-facing context resets at node boundaries.

This document reports facts. It does not recommend a design. All citations are
`path:line` in this repository, unless marked as a dependency
(`node_modules/@earendil-works/pi-ai`, version 1.4.0).

---

## 0. Baseline: how one record becomes one context today

| Fact | Source |
| --- | --- |
| A conversation is one durable `ChatRecord` holding native `messages: LhMessage[]`, plus `tree`, `turns`, `extractions`, `settings`, `sideChats` and `imageSnapshots`. | `src/core/contracts/chat.ts:24-54` |
| Every turn builds a fresh Pi `Agent` from the saved record. The agent's starting messages are the full record (`merged`), minus only Retry omissions. | `src/server/chat-handler.ts:601`, `:681`; `docs/architecture.md:23` |
| `toLlmMessages` is the single place where the model-facing view is built (the agent's `convertToLlm`). Its only history-dropping rule is the **active compaction cut**. | `src/core/native-messages.ts:653-747`; `src/agent/teacher-agent.ts:287` |
| The Agent's `sessionId` is the `chatId`. | `src/agent/teacher-agent.ts:246` |
| Plan position is derived, never stored. `current` is the `nodeId` of the most recent tagged `quiz`/`explain` **call**, and `visited` is every earlier run of calls. A→B→A counts as a revisit. | `src/core/contracts/plan.ts:45-60`, `:135-155` |
| A node boundary is only observable when the teacher **calls** a question tool with a new `nodeId`. The prompt tells it to pose a `predict` question *before* teaching the step: "asking about the next node IS how the lesson gets there". | `src/agent/prompts/teacher/10-planning.md:33` |
| Question tools (`quiz`, `probe`, `ask_user_question`, `explain`, `recall`) end the run. The learner's answer becomes the result of that call in the **next** turn. | `src/core/pending.ts:53-59`; `src/agent/tool-execute.ts:216-231`; `docs/architecture.md:78` |

The last two rows have one consequence for both shapes. **The call that opens
node B is made inside node A's context, and its answer arrives as input to the
next turn.** One assistant message can also carry several sibling question
calls, and these can tag different nodes (`docs/architecture.md:78`;
`plan.ts:138-150` folds them in order).

---

## 1. Per-chat liveness and the 409

**Where it lives**
- `src/server/turn-liveness.ts:32-112`: the `__lhTurnRegistry` and `__lhTurnOwners` maps on `globalThis`. `beginTurn` returns `false` when the chat already has a turn (`:59-67`), and there is a 30-minute TTL (`:48`).
- `src/server/turn-runs.ts:1-60`: `__lhTurnRuns`, which maps `chatId` to the live `PiTurnHandle`. This is the surface for reattaching (`GET /api/chats/:id/stream`) and for aborting remotely.
- `src/server/turn-preparation.ts:20-60`: `claimPreparingTurn(chatId)`.
- The 409 sites in `src/server/chat-handler.ts`: `:244-245` (plugin answer during a running turn), `:504-505` (compaction in flight), `:514-515` (preparation claim), `:563-565` (`beginTurn` failure).
- `src/server/compaction.ts:128-147`: `__lhCompaction.inFlight`, keyed by `chatId`, gates turns through `compactionInFlight`.

**What it keys on:** `chatId`. Within one record there is exactly one writer.

**Under (a):** each child has its own lock, so two node conversations of one
lesson can run turns at the same time. A job wake, a side delivery or a learner
send could each target a different child. Nothing at lesson level stops a
turn on child A (for example a wake that delivers a job result) from running
while the learner answers in child B. A lesson-level gate would have to cover
all children, either through a shared key or a parent lookup. The answer that
crosses the boundary (section 0) must be admitted under one lock, but the call
lives in A's record and the continuation belongs to B.

**Under (b):** nothing changes. There is still one record and one lock. The
reset happens inside the turn that holds it.

---

## 2. Turn construction from saved history (`toLlmMessages`)

**Where it lives**
- `src/core/native-messages.ts:653-747`, `toLlmMessages`:
  - It finds the active compaction marker through `activeCompactionOf` and `keptIndexFor` (`:662-675`). Everything before `firstKeptMessageId` is replaced by one user message holding the marker's text, and the other compaction markers are skipped (`:705`).
  - It keeps a leading system message, which carries the system prompt and tool declarations, ahead of that head (`:687-691`).
  - It flattens custom markers (graph context, handoff, job steer, side question and others) into user messages. Plan blocks and problem dismissals are dropped (`:695-714`).
  - It repairs dangling tool calls by looking **forward through the whole remaining list** for matching results (`:724-743`, `resultIdsFrom(messages.slice(i + 1))`).
- `src/server/chat-handler.ts:601`, `:663`, `:681`: the record, as `agentMessages`, seeds the Agent and the subscription request cycle.
- `src/server/chat-handler.ts:834`: `usedToolCallIds` is seeded from every tool-call id in the record, so new ids stay unique across the whole record.
- `src/server/turn-service.ts:59-92`, `persistTurn`: appends the turn's new messages after `persistBaseCount` and adds plan-block markers built from `record.tree`.

**What it keys on:** one ordered message list per record, with at most one
active cut, chosen as the newest compaction marker that has a
`firstKeptMessageId`.

**Under (a):** a child record starts empty unless something is copied in. Every
derivation from the transcript sees only the child: probe history, the
graph-context marker that is `message[0]` at session creation
(`app/api/chats/route.ts`, POST; `native-messages.ts:322-345`), the
`plan_init` call and result, and earlier answers. The node-opening call and its
result straddle two records (section 0). Tool-id uniqueness becomes per child.
Nothing in `toLlmMessages` needs to change; the work is in what seeds each
child.

**Under (b):** `toLlmMessages` supports exactly one cut, which is the newest
compaction marker. A node reset would need either:

- another active-cut source (a new marker type that the cut logic and every
  "stop at compaction" scan also honour; see sections 3 and 9), or
- node boundaries expressed *as* compaction markers. The data shape is a
  `firstKeptMessageId` plus model-facing text (`compaction.ts:264-294`).

In both cases the forward scan for dangling calls still reads past the boundary,
because it reads the full list. The cut point also has to be placed relative to
the node-opening question call and its answer. A cut after the call keeps it on
the wire. A cut before it leaves the answer, a tool result, without its call.
`compactionCutIndex` currently avoids that by choosing user, assistant or
custom entries as cut points (`compaction.ts:230-260`).

---

## 3. Compaction (trigger, summary, plan continuity)

**Where it lives**
- `src/core/compaction.ts`:
  - The contract: full history persists, and the projection is the summary plus the kept tail (`:7-16`).
  - The threshold is `min(setting, window − 16k)`, and the kept tail is about 20k tokens (`:47-57`).
  - The trigger estimate is anchored on the last assistant's reported usage. The scan **stops at the newest compaction marker** (`:153-166`, `:186-201`).
  - Cut selection starts at the previous kept boundary (`:230-260`).
  - The marker is built at `:284-294`, and the active marker is "the newest with a kept id" (`:299-323`).
  - The summary input is serialized at `:330-365`.
  - The plan tree goes in verbatim from `record.tree`, with statuses derived from the whole transcript (`:371-387`).
  - The prompt has four sections: the learner's understanding, the teaching arc, the plan tree, and the current moment (`:396-429`).
- `src/server/compaction.ts`:
  - `compact()` reads the record fresh, refuses while `isTurnRunning(chatId)`, cuts, summarizes, and inserts the marker where the summarized chat ended (`:186-294`).
  - Summary usage is appended to the **same chat's** `turns` (`:268-283`).
  - `ensureCompacted` and `kickCompaction` use the per-chat mutex (`:303-354`).
- Call sites:
  - Turn-start gate: `src/server/chat-handler.ts:387-430`. Its projection includes side cargo that has not yet been delivered.
  - Settle kick: `src/server/chat-handler.ts:926-949`.
  - `kind` is `teach` or `probe` depending on `hasProbeDone(record.messages)` (`:393`).

**What it keys on:** the `chatId` (mutex, record, usage log), one linear
history, `record.tree`, and the single active cut.

**Under (a):** each child compacts on its own and only sees its own span. The
summary's "teaching arc" and "learner's understanding" would cover only that
node, unless the parent's history is supplied. `planTreeToText(record.tree, …)`
returns `null` for a child with no tree, so the prompt would say "No plan tree
exists in this session" (`compaction.ts:405`). Summary usage lands on the child.
`kind` would be computed as `probe` for a child with no `probe_done`
(see section 12).

**Under (b):**
- Compaction and node resets would both drop history, and the cut logic assumes
  one chain of cuts. `compactionCutIndex` starts from the previous kept boundary
  and refuses to walk back across a compaction marker (`:231-258`). The span
  summarized runs from the previous kept boundary to the new cut
  (`server/compaction.ts:203-235`).
- A node boundary that is not a compaction marker would not be seen by
  `lastAssistantUsageIndex` (`:153-166`). Usage measured before the reset would
  then stay the trigger anchor and overstate the context.
- If node resets reuse compaction markers, the "anti-churn" guard
  (`server/compaction.ts:213-218`) and the "chained summary" behaviour
  (`:221-235`) would apply to node carry-over text as well.
- The existing summary prompt already carries the plan tree verbatim and the
  "current moment" across a cut (`compaction.ts:26-33`, `:416-422`). A node
  reset has the same continuity needs.

---

## 4. Side conversations and delivery into the main context

**Where it lives**
- Storage: `ChatRecord.sideChats` (`src/core/contracts/chat.ts:46-49`, `:150-162`). A thread is anchored on a *segment* id (`anchor.messageId`).
- Segments, `src/core/side-chat.ts:79-98`: a segment is the run of assistant messages between learner inputs or answers, and its id is the first assistant message id. Segments are **not** plan nodes.
- Delivery ledger, `src/core/side-chat.ts:130-153`: watermarks live inside immutable `side-question` custom entries in `record.messages`, and the comment says "Full native history survives compaction, so these stay recoverable".
- `sideConversationEntries` gathers changes from **all** threads in `record.sideChats` (`:155-200`).
- Helper context, `sideChatLessonDocument(record.messages)` (`:440-457`): renders the learner-visible lesson and honours the active compaction cut only, leaving out the private summary.
- Server, `src/server/side-chat.ts`:
  - Runs are keyed `chatId␀threadId` (`:60`).
  - `ask` resolves the segment from `record.messages`, checks that quote citations have `citation.chatId === chatId` and the same segment (`:120-151`), builds the lesson document from the whole record (`:175`), and records usage in the same chat's `turns` (`:215`).
  - `snapshot(chatId)` (`:236-243`) and `stopAll(chatId)` (`:260-261`).
- Main-context injection, `src/server/chat-handler.ts`:
  - The pre-turn projection is at `:397-427`.
  - `contextUpdates` runs per internal call and re-reads `getChat(chatId)` (`:698-719`).
  - `validateContext` performs the budget check (`:682-697`).
  - Delivery happens in `beforeCycle` (`:822-824`).
  - The budget uses the CLI window report (`src/server/side-context-budget.ts:10-15`).

**What it keys on:** `chatId` for runs, storage and events
(`side-chats-changed`, `src/core/events.ts:38`). The ledger is the record's
whole message list, and threads are keyed by segment id inside one record.

**Under (a):** threads opened on node A's segments live in child A's
`sideChats`. Today the main turn collects "new raw exchanges from **all**
conversations, including older steps" from the current record
(`docs/architecture.md:64`). Once the lesson has moved to child B, child A's
exchanges no longer reach the running context unless the collection spans the
lesson's children. Citation validation would reject a quote from another
child's message, because of `citation.chatId !== chatId` (`server/side-chat.ts:148`).
"Go to current step" (`components/side-thread.tsx:148`) means the current
segment of one record. The helper's lesson document would cover only the child.

**Under (b):** the ledger survives because history is never deleted. Entries
delivered before the boundary leave the wire with the reset, and exchanges
delivered later are appended after it. `sideChatLessonDocument` knows only the
compaction cut, so its scope (whole lesson or current node) is unchanged unless
it learns about node boundaries. The budget check (`fitsSideContext`,
`chat-handler.ts:370-384`) measures the projected wire, so it follows whatever
`toLlmMessages` drops.

---

## 5. Background job delivery (steer and wake)

**Where it lives**
- `JobRecord.chatId` (`src/core/contracts/jobs.ts:37`) is immutable (`src/core/ports.ts:185-186`). `listJobs(chatId)`, `findJobByToolCallId(chatId, toolCallId)` and `deleteJobsForChat(chatId)` are at `ports.ts:195-202`.
- `src/server/jobs.ts`:
  - Wake state on `globalThis`, all keyed by `chatId`: `queues`, `userSteers`, `liveAgents` and `pumping` (`:110-143`).
  - `deliverJobResult` resolves `chatIdOf(steer)` from the job record, or from the details of the probe handoff (`:229-233`, `:466-477`).
  - `registerLiveAgent(chatId, agent)` hands queued markers to the live run (`:299-307`).
  - The pump (`:489-620`) has two paths. Path 1 is the live run (`liveAgents.get(chatId)` with `isTurnRunning`). Path 2 is the idle wake, which goes through `turnRunner(chatId, { type: "steers" })` (`:597`).
  - The pump pauses on `endsInDismissal` or `endsInQuestionRecovery` of the record's tail (`:584`).
  - `waitForIdle` blocks while `isTurnRunning(chatId) || hasUnresolvedQuestion(record.messages)` (`:719-737`).
  - Deletion uses `discardChatDeliveries(chatId)` (`:211-218`).
- Delivery is acknowledged by a marker in the **saved conversation** (`docs/architecture.md:92`, `noteSteersDurable` at `:189-196`).

**What it keys on:** the `chatId` of the record whose turn dispatched the job.
"Pending question" and "dismissal pause" are read from that record's tail.

**Under (a):** a job dispatched while node A was active is delivered into child
A, as a live steer or an idle wake that runs a turn on A, even after the lesson
has moved on to child B. The wake would run a teacher turn on a node that is no
longer current. The tail gates read A's tail, not the lesson's. Redirecting
delivery to the active child would mean changing `chatIdOf` and the queue keys,
or adding a parent-to-active-child lookup. `findJobByToolCallId(chatId, …)`
assumes the dispatch call is in the same record as the delivery.

**Under (b):** delivery routing does not change. A job dispatched before a reset
delivers its marker after the reset, so the model sees a result for a dispatch
call that is no longer on the wire. Compaction can already produce the same
situation when the cut drops the dispatch.

---

## 6. Graph extraction and coverage ledgers

**Where it lives**
- `src/core/coverage.ts`:
  - The per-chat append-only ledger is keyed by content fingerprint (`:10-19`).
  - `coveredSet(entries, chatId)` filters on `e.chatId === chatId` (`:101-106`).
  - `coverageOf(messages, entries, chatId)` is at `:115-157`.
- `CoverageEntry { chatId, fp, tokens, foldedAt }`, `SessionCheckpoint { chatId }`, `ProvenancePoint { chatId, messageId }` and `GraphSnapshot.sessions` / `nodeSessions` (chatId → title, and nodeId → chatIds) are defined in `src/core/contracts/graph.ts:64-73`, `:137-156` and `:307-313`.
- Trigger: `triggerExtraction(…, chatId, chunkTokens)` reads the coverage of one record (`src/server/turn-service.ts:109-139`) and is called at settle (`chat-handler.ts:888-893`).
- Pipeline: `runExtraction(chatId)` runs one at a time per chat (`src/agent/subagents/extraction.ts:1097-1099`). Batches are serialized per source (`:1135-1160`), the view is `proseView(messages, record.title)`, and the submit step only accepts anchors from the batch's own message ids. Usage goes to `appendExtractionUsage(run.chatId, …)` (`:1035`).
- Clustering: birth-session clusters use the `chatId` of the **first provenance point** (`src/core/session-clusters.ts:12-50`).
- Links: `propositionSessionHref(node, chatId)` produces `/chat/<chatId>#message-<id>` (`src/core/session-navigation.ts:23-26`).
- Deletion: `deleteChatTraces(graphStore, chatId, mode)` (`src/core/graph-deletion.ts:95`), called by `deleteChatSession` (`src/server/chats.ts:99-159`), whose gates check running work and extraction for that `chatId`.

**What it keys on:** `chatId` throughout (coverage, provenance, clusters,
session titles, deletion, single-flight). Coverage reads the **full** record and
is independent of the model context (`docs/architecture.md:110`, "independent of
the lesson plan").

**Under (a):**
- Each child becomes its own extraction source. Coverage, provenance and
  extraction usage are split per child.
- Birth-session clustering would split one lesson into one cluster per child,
  because clusters are keyed by the first provenance `chatId`.
- `GraphSnapshot.sessions` would list children by their titles.
- Graph links would open the child record.
- Deleting a lesson would have to cascade over every child's traces, jobs and
  extractions, under per-child gates.
- The extractor only ever sees one child's prose, so each run lacks the prose
  of the other nodes.

**Under (b):** nothing changes. Coverage, extraction and provenance read the
full record, and the wire projection does not affect them.

---

## 7. Plan/tree storage and node tagging

**Where it lives**
- Storage: `ChatRecord.tree` (`contracts/chat.ts:34-35`). `saveTree(id, tree)` (`src/store/chats.ts:222-229`) is called only by `plan_init` (`src/agent/tools/plan.ts:74-98`), which reads `getChat(chatId)` and saves the tree.
- Node-id validation reads the **live record's tree**:
  - `nodeIdProblem` in `src/agent/tools.ts:355-369`, which says "No plan map exists yet — call plan_init before posing quizzes".
  - The teacher's guard in `src/agent/teacher-agent.ts:356-357`.
- Status derivation: `derivePlanStatusesLh(tree, messages)` folds tagged question calls across the whole message list (`src/core/contracts/plan.ts:135-155`). The same rule for view parts is at `:82-103`.
- Plan blocks: `planBlocksFor(record.messages, stamped, record.tree, …)` runs at persist (`turn-service.ts:82-86`; `plan-blocks.ts:75`).
- Phases:
  - `phaseAt3Lh(messages)` moves from probe to plan at the `probe_done` result, and from plan to teach at the first tagged call (`src/core/phases.ts:148-…`).
  - `ChatSummary.phase` (`src/store/chats.ts:110`) and the compaction summary (`compaction.ts:371-387`) use it.
- The `plan_init` result content sent to the model holds only the validated node ids and a reminder. The tree itself is in `details`, which the UI reads (`src/core/contracts/plan.ts:115-124`; `src/agent/tools/plan.ts:91-98`).

**What it keys on:** one `tree` per record, and one ordered list of calls per
record for position.

**Under (a):** a child has no `tree`. `nodeIdProblem` and the teacher guard
would reject every `nodeId` unless they read the parent's tree. Position
derivation (`current`/`visited`), revisits (A→B→A) and plan blocks would need a
fold across children in order. `plan_init` rewrites mid-lesson would have to
write the parent. The phase of a child would read as `probe`. The
node-opening call lives in the previous child (section 0). A multi-node sibling
batch would span children.

**Under (b):** storage, validation and derivation are unchanged, because they
read the full record. The model would lose the `plan_init` call and its
node-id reminder from the wire after the first reset, unless the
carry-over text re-injects them. The compaction summary already does this for
compaction cuts (`compaction.ts:30-31`).

---

## 8. Usage and the context meter

**Where it lives**
- `measuredContextTokens(messages, incompleteIds)` takes the latest completed assistant's usage and **returns null at the newest compaction marker** (`src/core/context-usage.ts:9-27`). It is consumed in `components/session-core.ts:386`.
- The denominator, `contextLimitForModel`, uses the catalog or the CLI window report (`components/stats-bar.tsx:16-21`). The CLI report comes from `cliContextWindowOf(messages)`, which also stops at a compaction marker (`src/core/native-messages.ts:117-127`), and is consumed in `components/chat.tsx:2081`.
- Money: `ChatRecord.turns` is an append-only usage log for the chat (`contracts/chat.ts:36-39`). Turn usage, side answers and compaction summaries all append to it (`chat-handler.ts:875-881`; `server/side-chat.ts:215`; `server/compaction.ts:268`). `sessionCacheHitRate(record)` is at `src/core/prices.ts:50`. The doc calls the meter "the latest qualifying completed conversation response" (`docs/compaction-accounting.md:5-7`).

**What it keys on:** one record's message tail, with a compaction marker as the
only invalidation, and one record's `turns`.

**Under (a):** the meter and cost cover only the open child. Showing lesson
totals would need aggregation across children. The CLI window report is per
child, and a new child has none until its first response
(`stats-bar.tsx:18-20`).

**Under (b):** after a node reset the meter keeps showing the pre-reset usage
until the next response. It is cleared only by a `compaction` marker
(`context-usage.ts:15`). The same applies to `cliContextWindowOf` and the
compaction trigger anchor (section 3). Cost and cache-hit rate stay
lesson-wide.

---

## 9. Sidebar and session listing

**Where it lives**
- `listChats()` reads **every** `data/chats/*.json` as one summary row. It derives `phase` (`phaseAt3Lh`), `pendingQuestion` and `pendingProblem` from that record's messages (`src/store/chats.ts:81-127`).
- `GET /api/chats` merges `busy: isTurnRunning(id)` and `compacting: compactionInFlight(id)` (`app/api/chats/route.ts`, GET).
- The sidebar shows the list flat. Row actions are per `chatId`: markdown export `/api/chats/:id/markdown`, coverage ring and rename/delete (`components/sidebar.tsx:408-459`, `:911-937`).
- Plugins see the same rows through `listSessions` / `getSession` (`src/server/plugin-learning.ts:30-33`).
- The page is `/chat/[id]`. `SessionCore` attaches to one stream, `/api/chats/:id/stream` (`components/session-core.ts:837`), and `projectView` projects one record (`src/core/view.ts:142`).
- Window events carry `{ chatId }`: `turn-started`, `record-changed`, `compaction-changed` and `side-chats-changed` (`src/core/events.ts:13-60`).

**What it keys on:** one row per file. The page, the stream and the view are
each per `chatId`.

**Under (a):**
- Child records would appear as sidebar rows, and as plugin "sessions", unless
  they are filtered out.
- The parent row's phase, pending-question and busy flags would have to be
  computed from its children.
- The lesson page would have to stitch several records and streams, or switch
  between them.
- Events, markdown export, find, image routes
  (`app/api/chats/[id]/images/[snapshotId]`; `ChatRecord.imageSnapshots`) and
  citations (`TutorCitation.chatId`, `src/core/citations.ts:34-37`) are all per
  record.

**Under (b):** nothing in the listing changes. Boundaries would need their own
rendering in the view. Today `projectView` draws a cut divider only for the
**active** compaction (`view.ts:180-198`).

---

## 10. Provider-specific session state

### Claude Code CLI
- `src/agent/claude-code/reuse-context.ts:5-27`: `conversationForReuse` (model-visible history only) and `configurationForReuse` (model, effort, system prompt, tools).
- `src/agent/claude-code/stream.ts`:
  - `canContinue` (`:469-478`) reuses a live CLI process only when the owner matches, `sessionId` matches (the `chatId`, through `teacher-agent.ts:246`), the configuration is deep-equal, and the recorded conversation is a **strict prefix** of the new one plus exactly the admitted tool results.
  - `continueLiveProcess` (`:622-637`) kills the process otherwise, and a fresh process gets a full replay (`:686-706`).
- Live processes are keyed by owner, `sessionId` and pending tool-call ids, and are kept for up to 10 minutes while a question waits for the learner (`src/agent/claude-code/live-processes.ts:1-43`).
- Each new process receives the whole projected conversation flattened into one user message (`src/agent/claude-code/transcript.ts:87-95`).
- The context-window report is attached per response (`cliContextWindow`) and read back until the newest compaction marker (`native-messages.ts:117-127`; `side-context-budget.ts:10-15`).

**Under (a):** the `sessionId` becomes the child id, so a waiting process from
child A cannot be continued by child B. The node-opening question (section 0)
holds a live process in A's session, and the answer has to resume that
process or be replayed into B.

**Under (b):** the `sessionId` is unchanged. A reset changes the projected
conversation, so `canContinue` fails the prefix check and the process is killed
and replaced with a full replay. That is the existing fallback path.

### Antigravity CLI
- There is no `src/agent/antigravity/request.ts` in this tree. The sizing and request code is in `src/agent/antigravity/provider.ts` and `stream.ts`:
  - Every model has a placeholder `contextWindow: 128_000` and `maxTokens: 16_384`, described as "Internal compaction budgets only" (`provider.ts:25-26`).
  - Every request writes the system prompt, tool schema and the **full** flattened conversation (`toClaudeInput`) to `request.txt` and spawns a fresh `agy` process (`stream.ts:73-104`).
  - There is no session reuse and no `sessionId` use. Output is capped at 16 MiB (`:118`).

**Under (a) / (b):** nothing is held between requests. Request size is the
projected wire, so it follows whatever the reset drops. The 128k placeholder
drives compaction thresholds through `catalogContextLimits` in both shapes.

### Pi API providers (dependency `node_modules/@earendil-works/pi-ai` 1.4.0)
- `SimpleStreamOptions.sessionId` is documented as "Optional session identifier for providers that support session-based caching" (`dist/types.d.ts:139-144`). It becomes `prompt_cache_key` (`dist/api/openai-responses.js:136`, `azure-openai-responses.js:155`), a cache session and session-affinity headers (`dist/api/anthropic-messages.js:421`, `:819-821`; `openai-completions.js:185`, `:544-553`).
- The Codex WebSocket continuation sends `previous_response_id` plus an input delta only when the new input has the old input plus output as a prefix. Otherwise it falls back to the full body (`dist/api/openai-codex-responses.js:1138-1167`).
- The app's own ChatGPT bridge passes `prompt_cache_key` through (`src/agent/chatgpt-stream.ts:26`).

**Under (a):** a new `sessionId` per child means a new cache key and affinity
per node.

**Under (b):** the same `sessionId` is kept, but the prefix changes at each
reset, so the cached prefix after the system prompt and tools no longer matches.
The Codex continuation falls back to a full send.

---

## 11. Session creation context (graph picks, settings)

- At creation, picked propositions become `message[0]`, a `graph-context` marker (`app/api/chats/route.ts`, POST; `native-messages.ts:322-345`). The strong-slot model and thinking level are stamped into `ChatRecord.settings` (`route.ts`, POST). Turns resolve the model from the record's settings (`contracts/chat.ts:59-70`).

**Under (a):** children need their own `settings`, or must inherit them. The
graph-context marker exists only in the parent unless it is copied.

**Under (b):** the marker sits before the first boundary, so it leaves the wire
at the first reset unless the carry-over text re-injects it. Compaction already
has this property today.

---

## 12. Agent selection and the probe-to-teach seam

- The agent is chosen from the transcript: `teaching = hasProbeDone(agentMessages)` (`chat-handler.ts:644`, `:735-791`; `native-messages.ts:899-923`). The prober and the teacher run over the same history, and the probe handoff is a custom marker addressed by `chatId` (`newHandoffMessage(chatId)`, `native-messages.ts:270`; `jobs.ts:469-471`).
- Continuation and pauses are read from the tail of one record: `needsContinuation`, `endsInDismissal` and `endsInQuestionRecovery` (`native-messages.ts:965-985`, `:1040-…`).

**Under (a):** a child without the `probe_done` pair would be built as the
**prober**. `kind` for compaction would be `probe`, and the phase would be
`probe`. Tail-derived continuation and pause rules read the child only.

**Under (b):** nothing changes, because these scans read the full record.

---

## Comparison: costs of (a) and (b)

| Area | (a) Child conversations | (b) Segments within one record |
| --- | --- | --- |
| Liveness / 409 (§1) | A lock per child, so a lesson-level gate is needed. The boundary answer is split across two locks. | Unchanged. |
| Wire building (§2) | `toLlmMessages` is unchanged. Each child must be seeded (probe history, graph picks, plan, learner state). | A second cut source, or node boundaries as compaction markers. The cut must be placed around the node-opening call and its answer. |
| Compaction (§3) | Per child. The summary sees no tree and is built for the `probe` kind. Usage is split. | Must agree with node resets. The "stop at compaction" anchor ignores other markers. The plan-tree and "current moment" carry-over already exists. |
| Side chats (§4) | Collection, citation check and lesson document are per child. Threads from earlier nodes stop reaching the live context. | The ledger is intact. The lesson document honours only compaction cuts. |
| Jobs (§5) | Delivered to the dispatching child. A wake can fire a turn on a node that is no longer current. Tail gates are per child. | Routing is unchanged. A result can arrive after its dispatch has left the wire, as compaction already allows. |
| Extraction / coverage / graph (§6) | Split into per-child sources, clusters, links and deletion cascades. | Unchanged. |
| Plan / tree / tagging (§7) | No tree in the child, so `nodeId` validation fails. Status, revisits and plan blocks need a fold across children. | Unchanged in storage. The `plan_init` reminder leaves the wire unless it is re-injected. |
| Meter / cost (§8) | Per child, so lesson totals need aggregation. | The meter and trigger anchor are stale until the next response unless the reset is a compaction marker. Cost is lesson-wide. |
| Sidebar / page / events (§9) | Children appear as rows and plugin sessions. One page and one stream per record. Images and citations are per record. | Unchanged. The view renders only the active cut's divider. |
| Claude Code (§10) | New `sessionId` per child. A waiting process cannot be resumed across children. | Prefix mismatch at reset, so the process is killed and replayed in full (the existing path). |
| Antigravity (§10) | Stateless. Size follows the child's projection. | Stateless. Size follows the projection. |
| Pi API caching (§10) | New cache key and affinity per child. | Same key. The prefix changes at each reset, and Codex falls back to a full send. |
| Agent selection (§12) | A child without `probe_done` is built as the prober. | Unchanged. |
