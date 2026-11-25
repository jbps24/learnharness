# 019 — Antigravity: resume the chat's agy conversation instead of replaying it

Status: **approved** 2026-11-25. Runs after plans 017 and 018.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill): `ladder queue --plan plans/019-agy-resume-conversation.md --step "Part 1" --step "Part 2"`. Build and install follow after asking (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests a part names as updated.

## What this fixes

agy never reuses anything. Every request, including each tool round trip inside one turn, is a new `agy` run in a new temporary folder with the whole prompt: teaching instructions, tool schemas and the full replayed chat (about 60k tokens with Gemini 4 Hydrogen). Over the 120 stored Hydrogen turns that was **4.29M** uncached input tokens against 2.19M read from cache; most turns had no cache hit.

**Measured 2026-11-25** (Gemini 4 Hydrogen, a 32k-token prompt, deny-all settings as in `AGY_SESSION_SETTINGS`):

| Run | Uncached input | Cache read |
|---|---|---|
| New run, folder A | 32,101 | 0 |
| Same prompt again, same folder A | 32,112 | 0 |
| Same prompt, new folder B | 32,108 | 0 |
| `--conversation <id>`, same folder, first resume | 36k over 2 steps | 30,357 |
| Second resume, same folder, per step | 2,422 and 2,201 | 30,483 and 30,856 |
| Resume from another folder, per step | 33,467, then 2,300 | 0, then 31,418 |

What this shows:
- Separate runs never share a cache, whatever the folder.
- A resumed conversation in the **same folder** sends about 2.3k uncached tokens per step instead of 32k+. Resuming from **another folder** works (the model remembered its earlier answer) but misses the cache on its first step, so the folder must stay fixed.
- `--json-schema` structured output works on a resumed run.
- On a resumed run `result.usage` is **cumulative over the whole conversation** (e.g. `num_turns` 5). Per-run usage must come from the run's own `step_update` usage events, where `input_tokens` excludes cache reads (`total_tokens = input + output`).
- The `init` event and `result` carry `conversation_id`.

## Owner decisions (2026-11-25)

1. Plan agy after 017, together with plan 018 for Claude.
2. **Resume the chat's agy conversation** (`--conversation <id>`) and send only the new messages.
3. **The link survives an app restart**, with one fixed workspace folder per chat under the data directory, deleted with the chat.

## Spec-level choices (approved with this plan)

- **Where the link lives.** The decision said "in the chat record". This plan stores it instead in the chat's agy workspace, `<DATA_ROOT>/agy/<chatId>/link.json` (mode 0600). That keeps provider state out of the chat format (`src/core/contracts/chat.ts`) while still surviving restarts and being deleted with the chat. Confirmed by the owner 2026-11-25.
- **Workspace.** `<DATA_ROOT>/agy/<chatId>/` (new `AGY_WORKSPACES_DIR` in `config.ts`, mode 0700), holding `.agents/mcp_config.json` as today. Each run's image files are written there and removed after the run. Requests without a `sessionId` (no chat) keep today's temporary folder and never resume.
- **Link content.** `{ conversationId, model, fingerprint, messageCount }`. `fingerprint` is the sha256 of the JSON of `{ systemPrompt, tools, conversation }`, where `conversation` is `conversationForReuse` of the messages the agy conversation holds: those sent so far plus the run's own final assistant message, exactly as returned to Pi. The link is written only after a usable run.
- **Resume when** a link exists, the model is the same, the fingerprint matches the first `messageCount` messages of the current request (with the current system prompt and tools), and every later message is a user or tool-result message (at least one). The run then uses `--conversation <id>` in the workspace and sends only those trailing messages. They use the same replay labels (`[user]`, `[tool result <name>]`, `[tool result <name> error]`) and end with `AGY_TRANSCRIPT_END`. Instructions, `ENGINE_INSTRUCTIONS` and the tool list are not resent: the conversation already holds them. `--json-schema`, `--model`, `--effort` and settings are passed as today.
- **Otherwise a full replay** as today, in the chat's workspace, which starts a new agy conversation. Its `conversation_id` becomes the new link. Cases include a model change, a changed system prompt or tools, a compaction, a retried or edited message, and a missing or corrupt link file.
- **Unusable run** (no structured output, or invented turns per `inventedTurns`). The conversation now holds that bad output, so the link is deleted. The existing one retry on `ANTIGRAVITY_FALLBACK_MODEL` runs as a full replay in a new conversation. If usable, it becomes the link with model `claude-sonnet-5-5`, so the next turn on the selected model replays fresh.
- **Usage.** For every run (resumed or not), usage is summed from the run's own `step_update` usage events: input = Σ `input_tokens`, cacheRead = Σ `cache_read_tokens`, output = Σ `output_tokens`. `result.usage` is no longer read.
- **Size cap.** `AGY_MAX_INPUT_BYTES` applies to the prompt actually sent; a resumed message is small. Compaction thresholds stay as they are. A compaction changes the history, so the next turn starts a new conversation by the rule above.
- **Concurrency.** Two runs for the same chat never resume the same conversation at once. A second run while one is active does a full replay without touching the link.

## Part 1 — Per-chat workspace and link store

Form: full

**Files.** `config.ts` (`AGY_WORKSPACES_DIR`). New `src/agent/antigravity/link.ts` (`workspaceFor(chatId)`, `readLink`, `writeLink`, `deleteLink`, `fingerprint(systemPrompt, tools, messages)`, `removeWorkspace(chatId)`). `src/server/chats.ts` (`finishChatDeletion` removes the chat's workspace). New tests `tests/antigravity-link.test.ts`, `tests/antigravity-workspace-deletion.test.ts`.

**Tests.** Workspace path under `LH_DATA_DIR`, created 0700 with `.agents/mcp_config.json` `{"mcpServers":{}}` 0600. Link round trip; a corrupt or missing link reads as none; link file 0600. Fingerprint changes with system prompt, tools, any message content or a tool-call id, and not with timestamps, usage or message ids. A chat id that is not a safe path segment is refused. Deleting a chat removes its workspace; deleting another chat leaves it alone.

## Part 2 — Resume, fresh replay, usage from steps

Form: full

**Files.** `src/agent/antigravity/stream.ts` (workspace instead of `mkdtemp` when `options.sessionId` is set; resume decision; `--conversation`; link write and delete; usage from steps; fallback rule). `src/agent/antigravity/request.ts` (`buildAntigravityResumePrompt(trailing, imagePath)`: labelled trailing messages + `AGY_TRANSCRIPT_END`). New test `tests/antigravity-resume.test.ts` (fake `run` as in `tests/antigravity.test.ts`, new helpers only). Updated tests: existing assertions on usage taken from `result.usage` (the implementer names them from a grep; they change to step-event usage with the same expected numbers), and any assertion that the cwd is a temporary `learnharness-agy-` folder when a `sessionId` is given.

**Tests.**
- First turn of a chat: full prompt, no `--conversation`, cwd = the chat's workspace. The link is written with the `init` event's `conversation_id`, the model and `messageCount`.
- Next request with one new user message: args contain `--conversation <id>`; the prompt is `[user]\n<text>` + `AGY_TRANSCRIPT_END`, with no instructions or tool list; same cwd.
- A tool round trip: the resumed prompt holds `[tool result <name>]\n<text>`.
- Fresh replay and a new link on: model change, system prompt change, tools change, edited earlier message, missing or corrupt link.
- Unusable first run: the link is deleted, the fallback runs without `--conversation`, and its id becomes the link with model `claude-sonnet-5-5`.
- Usage: two `step_update` usage events are summed; a cumulative `result.usage` is ignored.
- No `sessionId`: temporary folder, removed after the run; no link.
- Image in a resumed message: written into the workspace, referenced in the prompt, removed after the run.
- Concurrent run for the same chat: full replay, and the link is left unchanged.

**Docs.** None: `docs/architecture.md` does not describe the agy provider; the comments in `stream.ts` and `link.ts` are the record.

## Last stage — build and install (after the queue, not a ladder part)

`npm run desktop:dist`, then ask the owner before replacing `/Applications/LearnHarness.app`.

## Status per part

| Part | Status |
|---|---|
| 1 Per-chat workspace and link store | green (full), build-review/20261125-124323-019-part-1; paths fixed to plan in build-review/20261125-134745-019-part-2 (--issue, owner's choice) |
| 2 Resume, fresh replay, usage from steps | green (full), build-review/20261125-130139-019-part-2 + path fix build-review/20261125-134745-019-part-2; open: a failed/aborted resumed run keeps the link, so agy may see the new message twice next turn |
| Build and install | not started |
