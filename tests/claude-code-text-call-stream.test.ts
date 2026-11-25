import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
import { CLAUDE_TRANSCRIPT_END } from "../src/agent/claude-code/transcript.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const REPLY = JSON.stringify({ fake: "reply" });
const CLEANUP_TIMEOUT_MS = 2000;
const SESSION_ID = "text-call-stream-test";

const QUIZ_TOOL: Tool = { name: "quiz", description: "Ask a quiz question", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type ToolUse = { id: string; name: string; arguments: JsonObject };
type RunCall = { args: string[]; cwd: string; child: ChildProcessWithoutNullStreams };

function getFlagValue(args: string[], flag: string): string {
	const value = args[args.indexOf(flag) + 1];
	assert.ok(args.includes(flag) && value !== undefined, `missing ${flag}`);
	return value;
}

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function exitWith(code: number, stderr: string): string {
	return JSON.stringify({ fake: "exit", code, stderr });
}

function callTool(toolUse: ToolUse): string {
	return JSON.stringify({ fake: "call", id: toolUse.id, name: toolUse.name, arguments: toolUse.arguments });
}

function toTextStopScenario(text: string): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		HOLD,
	];
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

function createFakeRun(
	t: TestContext,
	scenario: string[],
	extraEnv: Record<string, string> = {},
): { runClaude: RunClaude; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-text-call-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const calls: RunCall[] = [];
	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, ...extraEnv },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		calls.push({ args, cwd: options.cwd, child });
		return child;
	};

	return { runClaude, calls };
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function getModel() {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	return model;
}

async function runScenario(
	t: TestContext,
	scenario: string[],
	messages: Message[] = [HI],
	extraEnv: Record<string, string> = {},
): Promise<{ events: AssistantMessageEvent[]; calls: RunCall[] }> {
	const { runClaude, calls } = createFakeRun(t, scenario, extraEnv);
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [QUIZ_TOOL] });
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), context, { sessionId: SESSION_ID }));
	return { events, calls };
}

async function runTurn(
	streamFunction: StreamFunction<Api, SimpleStreamOptions>,
	messages: Message[],
): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [QUIZ_TOOL] });
	const events = await collectEvents(streamFunction(getModel(), context, { sessionId: SESSION_ID }));
	const done = events.at(-1);
	assert.ok(done?.type === "done", `turn ended with ${done?.type}`);
	return done.message;
}

async function assertCleanedUp(call: RunCall): Promise<void> {
	if (call.child.exitCode === null && call.child.signalCode === null) {
		await assert.doesNotReject(once(call.child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }));
	}
	const privateDir = dirname(getFlagValue(call.args, "--system-prompt-file"));
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	for (const path of [call.cwd, privateDir]) {
		while (existsSync(path)) {
			assert.ok(Date.now() < deadline, `${path} was not removed`);
			await sleep(10);
		}
	}
}

// plan 017 part 1: a `stop` turn whose text ends with `[tool call quiz] {"type":"check",…}` gives `stopReason` `"toolUse"`, text without the line, one `toolCall`, and `toolcall_start`/`toolcall_end` events
test("stop turn ending with a declared text tool call becomes toolUse with toolcall events", async (t) => {
	const { events, calls } = await runScenario(
		t,
		toTextStopScenario('Let us check your understanding.\n\n[tool call quiz] {"type":"check","prompt":"What is TCP?"}'),
	);

	const done = events.at(-1);
	assert.ok(done?.type === "done");
	assert.equal(done.reason, "toolUse");
	assert.equal(done.message.stopReason, "toolUse");

	const textBlocks = done.message.content.filter((block) => block.type === "text");
	assert.deepEqual(textBlocks, [{ type: "text", text: "Let us check your understanding." }]);

	const toolCalls = done.message.content.filter((block) => block.type === "toolCall");
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0]?.name, "quiz");
	assert.deepEqual(toolCalls[0]?.arguments, { type: "check", prompt: "What is TCP?" });
	assert.ok(toolCalls[0]?.id);

	assert.equal(events.some((event) => event.type === "toolcall_start"), true);
	const toolCallEnd = events.find((event) => event.type === "toolcall_end");
	assert.ok(toolCallEnd?.type === "toolcall_end");
	assert.deepEqual(toolCallEnd.toolCall, toolCalls[0]);

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

// plan 017 part 1: undeclared tool name or bad JSON gives `stopReason` `"stop"`, line stripped, no `toolCall`
for (const bad of [
	{ label: "undeclared tool name", text: 'Here is text.\n\n[tool call unknown] {"type":"check"}' },
	{ label: "bad JSON", text: 'Here is text.\n\n[tool call quiz] {not json' },
]) {
	test(`stop turn with ${bad.label} stays stop with the line stripped and no toolCall`, async (t) => {
		const { events, calls } = await runScenario(t, toTextStopScenario(bad.text));

		const done = events.at(-1);
		assert.ok(done?.type === "done");
		assert.equal(done.reason, "stop");
		assert.equal(done.message.stopReason, "stop");
		assert.deepEqual(done.message.content, [{ type: "text", text: "Here is text." }]);
		assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);

		assert.equal(calls.length, 1);
		await assertCleanedUp(calls[0]!);
	});
}

// plan 017 part 1: a `stop` turn whose whole text is the call gives no text block and one `toolCall`
test("stop turn whose whole text is a valid tool call omits the text block and emits one toolCall", async (t) => {
	const { events, calls } = await runScenario(t, toTextStopScenario('[tool call quiz] {"type":"check"}'));

	const done = events.at(-1);
	assert.ok(done?.type === "done");
	assert.equal(done.reason, "toolUse");
	assert.equal(done.message.stopReason, "toolUse");
	assert.equal(done.message.content.some((block) => block.type === "text"), false);

	const toolCalls = done.message.content.filter((block) => block.type === "toolCall");
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0]?.name, "quiz");
	assert.deepEqual(toolCalls[0]?.arguments, { type: "check" });

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

// plan 017 part 1: Case 257's shape (call + invented result): one `toolCall` from the call, and the result text is gone
test("stop turn with text call and invented tool result salvages one toolCall and strips the result text", async (t) => {
	const { events, calls } = await runScenario(
		t,
		toTextStopScenario('Quick check.\n\n[tool call quiz] {"type":"check"}\n\n[tool result quiz]\n{"kind":"quiz"}'),
	);

	const done = events.at(-1);
	assert.ok(done?.type === "done");
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(
		done.message.content.filter((block) => block.type === "text"),
		[{ type: "text", text: "Quick check." }],
	);

	const toolCalls = done.message.content.filter((block) => block.type === "toolCall");
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0]?.name, "quiz");
	assert.deepEqual(toolCalls[0]?.arguments, { type: "check" });

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

// plan 017 part 1: `toolUse` turn with real MCP-admitted `quiz` call and text `[tool call quiz] {…}` strips text, keeps one admitted `toolCall`, and continues live process
test("mixed turn with real MCP call and text call strips text, keeps only the admitted call, and preserves continuation", async (t) => {
	const realQuiz: ToolUse = { id: "toolu_real_quiz", name: "quiz", arguments: { type: "real" } };
	const { runClaude, calls } = createFakeRun(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: 'Checking now.\n\n[tool call quiz] {"type":"fake"}' },
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: realQuiz.id, name: "mcp__learnharness__quiz", input: {} },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(realQuiz.arguments) },
		}),
		streamEvent({ type: "content_block_stop", index: 1 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		callTool(realQuiz),
		REPLY,
	]);

	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	assert.equal(toolMessage.stopReason, "toolUse");
	assert.deepEqual(toolMessage.content, [
		{ type: "text", text: "Checking now." },
		{ type: "toolCall", id: realQuiz.id, name: "quiz", arguments: { type: "real" } },
	]);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(realQuiz, "quiz answered")]);
	assert.equal(reply.stopReason, "stop");
	assert.deepEqual(reply.content, [{ type: "text", text: "quiz answered" }]);

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

// plan 017 part 1: an error turn is left as is
test("error turn is left as is without stripping or salvaging", async (t) => {
	const rawText = 'Partial.\n\n[tool call quiz] {"type":"check"}';
	const { events, calls } = await runScenario(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: rawText } }),
		exitWith(1, ""),
	]);

	const error = events.at(-1);
	assert.ok(error?.type === "error");
	assert.deepEqual(error.error.content, [{ type: "text", text: rawText }]);
	assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

// plan 017 part 1: the stdin line of a replayed turn ends with the CLAUDE_TRANSCRIPT_END block
test("stdin line of a replayed turn ends with the CLAUDE_TRANSCRIPT_END block", async (t) => {
	assert.ok(CLAUDE_TRANSCRIPT_END.length > 0);
	const stdinFile = join(mkdtempSync(join(tmpdir(), "claude-code-text-call-stdin-")), "stdin.jsonl");
	t.after(() => rmSync(dirname(stdinFile), { recursive: true, force: true }));

	const messages: Message[] = [
		HI,
		{
			role: "assistant",
			content: [{ type: "text", text: "Hello." }],
			api: "claude-code-cli",
			provider: "claude-code",
			model: "opus",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
		{ role: "user", content: "next", timestamp: 0 },
	];

	const { calls } = await runScenario(t, toTextStopScenario("Reply."), messages, { FAKE_CLAUDE_STDIN: stdinFile });
	const lines = readFileSync(stdinFile, "utf8").trim().split("\n");
	assert.ok(lines.length >= 3);

	const userInput = JSON.parse(lines[2]!) as { type: string; message: { content: Array<{ type: string; text?: string }> } };
	assert.equal(userInput.type, "user");
	assert.deepEqual(userInput.message.content.at(-1), { type: "text", text: CLAUDE_TRANSCRIPT_END });

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});

test("max_tokens turn with a text tool call keeps stopReason length and does not salvage", async (t) => {
	const { events, calls } = await runScenario(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: 'Truncated.\n\n[tool call quiz] {"type":"check"}' },
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		HOLD,
	]);

	const done = events.at(-1);
	assert.ok(done?.type === "done");
	assert.equal(done.reason, "length");
	assert.equal(done.message.stopReason, "length");
	assert.deepEqual(done.message.content, [{ type: "text", text: "Truncated." }]);
	assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);

	assert.equal(calls.length, 1);
	await assertCleanedUp(calls[0]!);
});
