/**
 * Reuse-rejection logging for Claude Code CLI process continuation (plan 018 part 1).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	JsonObject,
	Message,
	SimpleStreamOptions,
	StreamFunction,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const REPLY = JSON.stringify({ fake: "reply" });
const CLEANUP_TIMEOUT_MS = 2000;

const SESSION_ID = "reuse-log-test-chat";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type ToolUse = { id: string; name: string; arguments: JsonObject };

type RunCall = {
	child: ChildProcessWithoutNullStreams;
};

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

const TEXT_SCENARIO = [
	streamEvent({ type: "message_start", message: { usage: {} } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello there" } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	streamEvent({ type: "message_stop" }),
];

function toToolUseMessage(toolUses: ToolUse[]): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		...toolUses.flatMap((toolUse, index) => [
			streamEvent({
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: toolUse.id, name: `mcp__learnharness__${toolUse.name}`, input: {} },
			}),
			streamEvent({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.arguments) },
			}),
			streamEvent({ type: "content_block_stop", index }),
		]),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

function callTool(toolUse: ToolUse): string {
	return JSON.stringify({ fake: "call", id: toolUse.id, name: toolUse.name, arguments: toolUse.arguments });
}

function toToolResult(toolUse: ToolUse, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolUse.id,
		toolName: toolUse.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function getModel() {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	return model;
}

function createFakeRun(t: TestContext, scenario: string[]): { runClaude: RunClaude; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-reuse-log-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const calls: RunCall[] = [];
	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		calls.push({ child });
		return child;
	};

	return { runClaude, calls };
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function runTurn(
	streamFunction: StreamFunction<Api, SimpleStreamOptions>,
	messages: Message[],
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	const events = await collectEvents(streamFunction(getModel(), context, { sessionId: SESSION_ID, ...options }));
	const done = events.at(-1);
	assert.ok(done && done.type === "done", `turn ended with ${done?.type}`);
	return done.message;
}

function getText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }));
}

function captureConsoleError(t: TestContext): string[] {
	const lines: string[] = [];
	const original = console.error;
	t.after(() => { console.error = original; });
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return lines;
}

// plan 018 part 1: nothing is logged when reuse succeeds
test("successful continuation logs nothing", async (t) => {
	const read: ToolUse = { id: "toolu_log_success", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const message = await runTurn(stream, [HI]);

	const logs = captureConsoleError(t);
	const reply = await runTurn(stream, [HI, message, toToolResult(read, "contents of a")]);

	assert.equal(getText(reply), "contents of a");
	assert.deepEqual(logs, []);
	assert.equal(calls[0]!.child.exitCode, null);
	assert.equal(calls[0]!.child.signalCode, null);
});

// plan 018 part 1: only logs when request has a sessionId
test("request without sessionId logs nothing when continuation is not possible", async (t) => {
	const read: ToolUse = { id: "toolu_log_no_session", name: "read", arguments: { path: "a" } };
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction(fresh.runClaude);
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: read.id, name: read.name, arguments: read.arguments }],
		api: getModel().api,
		provider: getModel().provider,
		model: getModel().id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, assistant, toToolResult(read, "A")], { sessionId: undefined });

	assert.deepEqual(logs, []);
	await waitForExit(fresh.calls[0]!.child);
});

// plan 018 part 1: only logs when newest assistant message has tool calls
test("request whose newest assistant message has no tool calls logs nothing", async (t) => {
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction(fresh.runClaude);
	const textAssistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "plain reply" }],
		api: getModel().api,
		provider: getModel().provider,
		model: getModel().id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, textAssistant, { role: "user", content: "follow up", timestamp: 0 }]);

	assert.deepEqual(logs, []);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs no held process and held count for session when none matches ids
test("logs no held process with 0 held for session when none exists", async (t) => {
	const read: ToolUse = { id: "toolu_log_missing", name: "read", arguments: { path: "a" } };
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction(fresh.runClaude);
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: read.id, name: read.name, arguments: read.arguments }],
		api: getModel().api,
		provider: getModel().provider,
		model: getModel().id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, assistant, toToolResult(read, "A")]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: no held process\b/);
	assert.match(logs[0]!, /\b0\b/);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs no held process and held count for session when ids do not match
test("logs no held process with 1 held for session when ids do not match", async (t) => {
	const held: ToolUse = { id: "toolu_log_held_id", name: "read", arguments: { path: "a" } };
	const other: ToolUse = { id: "toolu_log_other_id", name: "read", arguments: { path: "b" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([held]), callTool(held), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const heldMessage = await runTurn(stream, [HI]);

	const wrongAssistant: AssistantMessage = {
		...heldMessage,
		content: [{ type: "toolCall", id: other.id, name: other.name, arguments: other.arguments }],
	};
	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, wrongAssistant, toToolResult(other, "B")]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: no held process\b/);
	assert.match(logs[0]!, /\b1\b/);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs configuration:<key> for differing model, effort, systemPrompt, tools, env
for (const key of ["model", "effort", "systemPrompt", "tools", "env"] as const) {
	test(`logs configuration:${key} when ${key} differs`, async (t) => {
		const read: ToolUse = { id: `toolu_log_cfg_${key}`, name: "read", arguments: { path: "a" } };
		const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
		const fresh = createFakeRun(t, TEXT_SCENARIO);
		const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
		const message = await runTurn(stream, [HI]);

		if (key === "env") {
			const saved = process.env.ANTHROPIC_AUTH_TOKEN;
			t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved; });
			process.env.ANTHROPIC_AUTH_TOKEN = "changed-token-for-log-test";
		}

		const context = normalizeContext({
			systemPrompt: key === "systemPrompt" ? "Changed tutor instructions" : "You are a tutor.",
			messages: [HI, message, toToolResult(read, "A")],
			tools: [{
				...READ_TOOL,
				...(key === "tools" ? { description: "Changed tool description" } : {}),
			}],
		});
		const model = key === "model" ? CLAUDE_CODE_MODELS[1]! : getModel();
		const options: SimpleStreamOptions = {
			sessionId: SESSION_ID,
			...(key === "effort" ? { reasoning: "high" } : {}),
		};

		const logs = captureConsoleError(t);
		await collectEvents(stream(model, context, options));

		assert.equal(logs.length, 1);
		assert.match(logs[0]!, new RegExp(`^claude CLI reuse rejected: configuration:${key}\\b`));
		await waitForExit(waiting.calls[0]!.child);
		assert.equal(fresh.calls[0]!.child.exitCode, null);
		assert.equal(fresh.calls[0]!.child.signalCode, null);
	});
}

// plan 018 part 1: configuration:<key> logs the first key that differs
test("configuration:<key> logs the first key that differs", async (t) => {
	const read: ToolUse = { id: "toolu_log_cfg_order", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI]);

	const context = normalizeContext({
		systemPrompt: "Changed tutor instructions",
		messages: [HI, message, toToolResult(read, "A")],
		tools: [READ_TOOL],
	});

	const logs = captureConsoleError(t);
	await collectEvents(stream(CLAUDE_CODE_MODELS[1]!, context, { sessionId: SESSION_ID }));

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: configuration:model\b/);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs history with index and role of first differing message
test("logs history with index 0 and role user when first message differs", async (t) => {
	const read: ToolUse = { id: "toolu_log_hist_user", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI]);

	const logs = captureConsoleError(t);
	await runTurn(stream, [{ ...HI, content: "different first message" }, message, toToolResult(read, "A")]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: history\b/);
	assert.match(logs[0]!, /\b0\b/);
	assert.match(logs[0]!, /\buser\b/);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs history with index and role of first differing message
test("logs history with index 1 and role assistant when assistant message differs", async (t) => {
	const read: ToolUse = { id: "toolu_log_hist_assistant", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI]);

	const alteredAssistant: AssistantMessage = {
		...message,
		content: [{ type: "text", text: "altered assistant text" }, ...message.content],
	};

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, alteredAssistant, toToolResult(read, "A")]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: history\b/);
	assert.match(logs[0]!, /\b1\b/);
	assert.match(logs[0]!, /\bassistant\b/);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs message-count when message count differs
test("logs message-count when conversation length does not match held process plus admitted calls", async (t) => {
	const read: ToolUse = { id: "toolu_log_msg_count", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI]);

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, message]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: message-count\b/);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: logs results when tool results do not match admitted calls
test("logs results when tool results do not match admitted calls", async (t) => {
	const read: ToolUse = { id: "toolu_log_results", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI]);

	const logs = captureConsoleError(t);
	await runTurn(stream, [HI, message, toToolResult({ ...read, id: "toolu_wrong_id" }, "A")]);

	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /^claude CLI reuse rejected: results\b/);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});

// plan 018 part 1: no message content is logged
test("logged text never contains message content", async (t) => {
	const marker = "SECRET_MARKER_CONTENT_98765";
	const read: ToolUse = { id: "toolu_log_marker", name: "read", arguments: { path: marker } };
	const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
	const fresh = createFakeRun(t, TEXT_SCENARIO);
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));

	const secretUser: Message = { role: "user", content: `prompt with ${marker}`, timestamp: 0 };
	const message = await runTurn(stream, [secretUser]);

	const logs = captureConsoleError(t);
	await runTurn(stream, [{ ...secretUser, content: `changed ${marker}` }, message, toToolResult(read, `result ${marker}`)]);

	assert.equal(logs.length, 1);
	assert.equal(logs[0]!.includes(marker), false);
	await waitForExit(waiting.calls[0]!.child);
	assert.equal(fresh.calls[0]!.child.exitCode, null);
	assert.equal(fresh.calls[0]!.child.signalCode, null);
});
