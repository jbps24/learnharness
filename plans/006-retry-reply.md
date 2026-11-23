# 006 — Retry the latest teacher reply

Status: **approved** 2026-11-22.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts through the ladder (`execute-plan` skill): `ladder queue --plan plans/006-retry-reply.md --step "Part 1" --step "Part 2" --step "Part 3"`.
3. After each part is green, update "Status per part" below.

## What this adds

Today **Retry** exists only for a failed turn (`{ type: "retry" }`, the error banner in `components/chat.tsx`). A reply that finished but is wrong cannot be redone. Example: the Regelungssysteme chat, 2026-11-22 12:51, where the teacher said all five units were done (see plan 005). This plan adds **Retry** for the latest teacher reply. It runs the same turn again from the learner's last input, on the chat's current model. The old reply leaves the chat and the teacher's context, but stays in the saved record.

## Owner decisions (2026-11-22)

Amended 2026-11-22: plan 007 runs before this plan, and its two course notes are skipped like the break note (owner-approved).

1. Only the **latest** teacher reply can be retried, also one that ends with an open question or check.
2. The old reply is **hidden and kept on disk**: it is moved out of `messages` into a new record field, so the chat, the teacher and every other reader stop seeing it.
3. Only **effect-free** replies can be retried: text, read-only lookups, and questions for the learner. A reply that started a job, wrote the plan, concluded, offered a break or did anything else lasting gets no Retry.
4. The retry runs on the **chat's current model** (whatever it is when Retry is pressed).
5. The button sits **under the latest reply and is always visible** while a retry is possible.

## Scope rules (fixed by this plan)

- Teaching chats only (`record.kind !== "practice"`).
- The reply must answer a **learner input**: a `user` message (text input) or a `toolResult` of a tool in `QUESTION_TOOLS` (`src/core/pending.ts`: `quiz`, `probe`, `ask_user_question`, `explain`, `recall`). Replies to automatic wakes, plugin questions or submissions, `break-continue` and practice inputs are out of scope.
- An errored latest reply keeps the existing failed-turn Retry; this one does not apply. An aborted reply (`stopReason: "aborted"`) is not retryable either.
- No compaction may sit between the input and the reply (it stops the walk below).

## Part 1 — Core: which messages form a retryable reply, and the input type

**Code.**
- `src/core/input-events.ts`:
  - `ChatInput` gains `| { type: "retry-reply" }`; `parseChatInput` (the `switch` with `case "retry"`) gains `case "retry-reply": return { type: "retry-reply" };`.
  - New exported constant `REPLY_RETRY_READ_ONLY_TOOLS = ["find", "find_candidates", "grep", "list_propositions", "list_sessions", "ls", "pdf", "pdf_extract", "pdf_info", "pdf_search", "read", "show_image", "web_fetch", "web_fetch_pdf", "web_search"] as const`.
  - New exported pure function `retryableReply(messages: readonly LhMessage[]): string[] | null`. It walks back from the end:
    - a `custom` message that is a side-question marker (`isSideQuestionMarker`) or has `customType` `"break-note"`, `"graph-context"`, `"units-note"`, `"course-files"` or `"course-method"` is **skipped** (stays, not collected). The last two are plan 007's course notes, which run before this plan;
    - an `assistant` message is **collected**;
    - a `toolResult` whose `toolName` is not in `QUESTION_TOOLS` is **collected**;
    - any other message **stops** the walk and is the **input**.
  - It returns the collected ids in record order when all of these hold, else `null`:
    - at least one assistant was collected;
    - the input exists and is a `user` message or a `toolResult` whose `toolName` is in `QUESTION_TOOLS`;
    - every collected assistant has `stopReason` `"stop"` or `"toolUse"`;
    - every `toolCall` block in the collected assistants is named in `REPLY_RETRY_READ_ONLY_TOOLS` or `QUESTION_TOOLS`;
    - every collected `toolResult` has a `toolName` in `REPLY_RETRY_READ_ONLY_TOOLS`.
- `src/core/contracts/chat.ts`: `ChatRecord` gains `retiredReplies?: RetiredReply[]`, with new exported `interface RetiredReply { at: string; messages: LhMessage[] }` (doc comment: replies replaced by Retry, kept for diagnosis, never shown and never sent to a model). No record version bump.
- `src/core/index.ts` exports what the server and client need (`retryableReply`, `REPLY_RETRY_READ_ONLY_TOOLS`, `RetiredReply`), following how its neighbours are exported.

**Tests** (new file `tests/retry-reply-core.test.ts`, new helpers only):
- `parseChatInput({ type: "retry-reply" })` → `{ type: "retry-reply" }`.
- Text input, then an assistant with text only (`stop`) → its id.
- `explain` answer (`toolResult`, `toolName: "explain"`), `break-note`, then an assistant with text only → the assistant id (the break note stays out). This is the Regelungssysteme shape.
- `user`, then assistant calling `pdf` (`toolUse`), `toolResult` `pdf`, then assistant text plus an `explain` call with no result (`toolUse`) → the three ids in order.
- A side-question marker after the reply → still retryable, the marker id not returned.
- `user`, a `course-files` note and a `course-method` note (plan 007), then an assistant with text only → the assistant id (both notes stay out).
- Not retryable (`null`): an empty record; the last message is a `user`; the last assistant has `stopReason` `"error"` or `"aborted"`; the reply calls `demo` (with its `toolResult`), `suggest_break`, `plan_init`, `conclude` or `probe_done`; a `compaction` or `lesson-record` or `plan-block` marker between input and reply; the input is a `subagent-steer` custom message; the input is a `toolResult` of `demo`.

## Part 2 — Store and server: retire the reply and rerun the turn

**Code.**
- `src/core/ports.ts`, `ChatStore`: new method `retireReply(id: string, ids: readonly string[], at: string): void`. Doc comment: in one write, removes the messages with these ids from `messages` and appends `{ at, messages: removed }` (in record order) to `retiredReplies`; throws if the chat is missing or any id is not in `messages`; silent like `saveMessages`.
- `src/store/chats.ts`: implements it like `saveMessages` (read, change, set `updatedAt`, `writeChat`), and exports it with the other store functions.
- Any other `ChatStore` implementation or test double the compiler finds gets the method (same behaviour, or a throwing stub in test doubles that never call it).
- `src/server/chat-handler.ts`, input `retry-reply`:
  - Early refusal next to the existing `retry` check (~l.293): if `record.kind === "practice"` or `retryableReply(record.messages)` is `null` → `400 { error: "There is no reply to retry." }` (the same response shape the `retry` refusal uses), before any turn or write effect.
  - Revalidate on current truth where `retry` does (~l.505); `null` → the same 400. The ids found there are the **retire ids**.
  - At every other place that treats `input.type === "retry"` specially for the agent's context (the compaction-gate omission ~l.455, `sideContextWindow(..., isRetry)` ~l.412, `agentMessages` ~l.651), `retry-reply` behaves like `retry` with the retire ids as the omissions. The units-note condition (~l.617) and the break-note condition stay as they are (no appends for `retry-reply`).
  - The input has no native appends. After `turnClaimed`, instead of the plain write-ahead `saveMessages(chatId, merged)`, it calls `stores.chatStore.retireReply(chatId, retireIds, new Date().toISOString())`. `merged` and `agentMessages` are the record messages without the retire ids, and `persistBaseCount` is their length. A failure of `retireReply` returns the same 500 as a failed write-ahead.
  - The turn then runs exactly as a `retry` does (continuing from the input), on the chat's current model; usage is logged as for any turn; `emit("record-changed", { chatId })` follows as for other turns.

**Tests** (new file `tests/retry-reply-server.test.ts`, new helpers only; the chat-handler style of the existing retry tests may be followed, their fixtures not reused):
- `retireReply` on a temp store: messages `[u, a1, r1, a2]`, ids `[a1, r1, a2]` → `messages` is `[u]`, `retiredReplies` is `[{ at, messages: [a1, r1, a2] }]`; a second call appends a second entry; an unknown id throws and changes nothing.
- Handler: a teaching chat ending in `user` + assistant text, POST `{ type: "retry-reply" }` with a fake model answering "Second" → the saved record has `[user, new assistant "Second"]`, `retiredReplies[0].messages` holds the old assistant, and the request the fake model received ends with the user message (no old reply in it).
- Handler refusals, each `400 "There is no reply to retry."` with the record unchanged: practice chat; record ending in a `user` message; reply that called `demo`.

## Part 3 — UI: the Retry button under the latest reply

**Code** (`components/chat.tsx`):
- `replyRetryable = !pluginOwnsDock && (status === "ready" || status === "error") && !busy && !compacting && !turnInFlight && !error && kind !== "practice" && retryableReply(nativeMessages) !== null` (`kind` is the component's existing session kind; the other names are its existing state names).
- New exported helper next to `retryFailedResponse`: `retryLatestReply(send, submittedDraft)` sets `submittedDraft.current = null` and sends `{ type: "retry-reply" }`.
- Rendering: in the transcript tail, before the `compacting` / `PendingTurnIndicator` block (~l.2110), when `replyRetryable`: `<Button variant="ghost" size="xs" data-testid="retry-reply" onClick={…}>` with a `RotateCcwIcon` (lucide, `aria-hidden`) and the text `Retry`. It sits directly after the latest reply, left-aligned like the reply.

**Tests** (new file `tests/retry-reply-ui.test.tsx`, in the style of the existing component tests, new helpers only):
- `retryLatestReply` clears the draft ref and sends `{ type: "retry-reply" }`.
- The button shows for a record ending in a text-only reply (status ready) and is absent when a turn is in flight, when the record ends in a `user` message, when the reply called `demo`, and in a practice chat.

**Docs.**
- `docs/architecture.md`, the paragraph on provider-response retry (~l.56): add one sentence: the latest effect-free teacher reply to a learner input can also be retried; it moves to `retiredReplies` (kept, never shown or sent to a model) and the turn runs again from that input on the chat's current model.
- `CONTEXT.md`: a short **Retry a reply** entry next to related chat terms, with the same content in plain words.

---

## Status per part

| Part | Status | Build id |
|---|---|---|
| 1 Core: retryable reply and input type | green, build-review/20261123-214225-006-part-1 | - |
| 2 Store and server | green, build-review/20261123-220453-006-part-2 | - |
| 3 UI button | green, build-review/20261123-222810-006-part-3 | - |
