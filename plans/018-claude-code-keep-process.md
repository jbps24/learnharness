# 018 — Claude Code: keep the CLI process between turns

Status: **approved** 2026-11-25. Runs after plan 017 (both change `src/agent/claude-code/stream.ts`).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill): `ladder queue --plan plans/018-claude-code-keep-process.md --step "Part 1" --step "Part 2"`. Build and install follow after asking (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests a part names as updated.

## What this fixes

Every claude-code turn that cannot continue a live CLI process starts a new `claude` process and replays the whole chat as one text block. That block cannot match the earlier prompt cache, so the whole history is written to the cache again. In the signal-processing chat (`chat_mvvbllhn_781793fa`, 244 Sonnet turns) the 50 fresh replays wrote **3.75M** cache tokens. The 99 continuations wrote 0.23M. A replay writes 85–133k tokens to the cache; a continuation reads about 104k and writes 1–3k.

Why the 50 replays happened:

| Cause | Replays | Cache writes |
|---|---|---|
| Previous turn ended normally, so its process was killed (`handleLine`: `if (this.turn.finished) this.kill()`) | 15 | 0.95M |
| Question answered after more than 10 minutes (`LIVE_PROCESS_IDLE_TIMEOUT_MS`) | 11 | 0.99M |
| Answered within 10 minutes, but reuse was rejected; cause unknown, nothing is logged | 13 | 0.93M |
| Previous turn errored or was aborted | 8 | 0.57M |
| Switched from another provider | 3 | 0.30M |

Replays also cause plan 017's bug: 9 of its 11 cases were replay turns.

**Measured 2026-11-25:**
- The CLI writes its cache with a 1-hour lifetime (`cache_creation.ephemeral_1h_input_tokens`; the 5-minute bucket stays 0).
- A second stream-json user message sent to the same `claude -p --input-format stream-json` process runs a second turn with full memory of the first: 15,094 cache-read tokens and 215 cache-write tokens. The app already keeps stdin open (`stream.ts:459-460` only write, never end).

## Owner decisions (2026-11-25)

1. Plan both providers after 017; this plan covers Claude, plan 019 covers agy.
2. **Keep the process after every turn**, not only while a tool call waits.
3. **Idle limit 50 minutes** for every held process; **CLI tool timeout 60 minutes** (`MCP_TOOL_TIMEOUT`), up from 30.
4. **At most 3 held processes app-wide.** Holding a 4th kills the one idle longest. A process waiting for tool results counts.

## Spec-level choices (approved with this plan)

- **Log first.** Part 1 only adds logging, so the 13 unexplained rejections can be traced in real use. A fix for whatever it finds is a later plan.
- **Held after a finished turn.** A turn that ends with `stop` or `length` and has a `sessionId` keeps its process. Its reuse snapshot becomes the conversation plus the turn's final message, with no pending tool calls. Error and aborted turns still kill. Without a `sessionId` the process is killed as today.
- **One held process per session.** Holding a new one for the same owner and session kills the previous one.
- **Continuing after a finished turn.** This applies when the newest assistant message has no tool calls. The held process for the same owner and session is continued only if: the configuration is equal; `conversationForReuse(messages)` starts with the held snapshot; and every message after the snapshot is a user message (at least one, no `toolResult`). The continuation writes **one** stream-json user line whose content is those messages' content blocks in order, unlabelled, with images kept (as `toUnlabelledBlocks` does for a single message). This is what the native API would see: consecutive user messages. If any check fails, the process is killed and the turn replays fresh.
- **Late CLI lines.** After a `stop`, the CLI still prints its `result` line. Today that is ignored only because `kill()` sets `stopping`. A held process must accept the rest of the finished turn's output and must not fail with "moved on while harness tool calls were waiting". Any assistant output before the next user line is still a failure.
- Tool-wait continuation (today's path) is unchanged except for the idle limit and the cap.

## Part 1 — Log why reuse is rejected

Form: light

**Files.** `src/agent/claude-code/stream.ts` (`ClaudeProcess.rejectReason(...)`: `canContinue` becomes `rejectReason(...) === null`; `continueLiveProcess` logs). New test `tests/claude-code-reuse-log.test.ts`.

**Behaviour.** When a request has a `sessionId` and its newest assistant message has tool calls, `continueLiveProcess` logs one line through `console.error` (it reaches `userData/logs/main.log`) whenever it does not continue:
- `claude CLI reuse rejected: no held process` when none matches the ids. This line also reports how many processes are held for this session, so a lookup failure on changed ids can be told apart from an expired or never-held process.
- otherwise `claude CLI reuse rejected: <reason>`, with reason one of `stopping`, `owner`, `session`, `configuration:<key>` (key: `model`, `effort`, `systemPrompt`, `tools` or `env`, the first that differs), `history` (prefix differs; also logs the index of the first differing message and its role), `message-count`, `results`.

Nothing is logged when reuse succeeds. No message content is logged.

**Tests.** Each reason is logged once with the expected text. A successful continuation logs nothing. Logged text never contains message content (a test conversation with a marker string; the marker must not appear in the log).

## Part 2 — Hold processes after finished turns, 50-minute limit, cap of 3

Form: full

**Files.** `src/agent/claude-code/stream.ts` (hold after `stop`/`length`, continuation with a new user line, late `result` line, `MCP_TOOL_TIMEOUT_MS = 60 * 60_000`). `src/agent/claude-code/live-processes.ts` (`LIVE_PROCESS_IDLE_TIMEOUT_MS = 50 * 60_000`, lookup by owner + session for finished turns, cap 3 with eviction of the longest idle). `src/agent/claude-code/transcript.ts` (export the unlabelled block conversion if needed). `docs/claude-code.md` (held-process lifetime, 50/60 minutes, cap, continuation after finished turns).

**Updated tests.** `tests/claude-code-stream.test.ts:809` (asserts `600000`; becomes `3000000` and the message "learner-wait retention stays at fifty minutes"). Any existing test that asserts a process is killed after a `stop` turn with a `sessionId`; the implementer names them from a grep, and only those assertions change.

**New tests** (`tests/claude-code-keep-process.test.ts`, fake CLI, new helpers only):
- A `stop` turn with a `sessionId` leaves the process alive. The next request with one new learner message spawns no process and writes exactly one stdin line equal to `toStreamJsonLine([{ type: "text", text: "<learner text>" }])`. The streamed answer becomes the result.
- Two trailing user messages (the learner's text and an image) become one line with both blocks in order.
- The CLI's `result` line after `stop` does not fail the held process.
- Not continued, and replayed fresh in a new process: changed effort, model, system prompt or tools; an edited earlier message; a trailing `toolResult`; an assistant message after the snapshot.
- No `sessionId`: killed after `stop` as today. An error or aborted turn: killed.
- A second finished turn in the same session replaces the held process; the old one is killed.
- Cap: holding a 4th process kills the one held longest-idle; the other 3 stay. A process waiting for tool results counts.
- Idle: the held process is killed after `liveProcessIdleTimeoutMs.current` (seam), and the next turn replays fresh.
- The `MCP_TOOL_TIMEOUT` env equals `3600000` and is greater than the idle limit.
- Abort while held kills the process.

## Last stage — build and install (after the queue, not a ladder part)

`npm run desktop:dist`, then ask the owner before replacing `/Applications/LearnHarness.app`.

## Status per part

| Part | Status |
|---|---|
| 1 Log why reuse is rejected | green (light), build-review/20261125-113646-018-part-1 |
| 2 Hold processes after finished turns | green (full), build-review/20261125-114419-018-part-2; 2 rulings (017 text-call tests updated: held process stays alive); open: abort of the last request's signal kills a held process |
| Build and install | dist built; install after plan 019 (owner) |
