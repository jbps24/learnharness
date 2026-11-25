/**
 * Tests for keeping Claude Code CLI processes alive between finished turns
 * (Plan 018, Part 2). Uses tests/fixtures/claude-code/fake-claude.mjs with
 * self-contained helpers.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	AssistantMessage,
	AssistantMessageEvent,
	JsonObject,
	Message,
	SimpleStreamOptions,
	StreamFunction,
	Api,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } from "../src/agent/claude-code/live-processes.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { toStreamJsonLine } from "../src/agent/claude-code/transcript.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const WAIT_FOR_MESSAGE = JSON.stringify({ fake: "wait-for-message" });
const CLEANUP_TIMEOUT_MS = 2000;

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type FakeCall = {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	child: ChildProcessWithoutNullStreams;
	userLines: string[];
};

function getFlagValue(args: string[], flag: string): string {
	const value = args[args.indexOf(flag) + 1];
	assert.ok(args.includes(flag) && value !== undefined, `missing ${flag}`);
	return value;
}

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function textTurn(text: string, stopReason: "end_turn" | "max_tokens" = "end_turn"): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

function toolUseTurn(id: string, name: string, args: JsonObject): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name: `mcp__learnharness__${name}`, input: {} },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		JSON.stringify({ fake: "call", id, name, arguments: args }),
	];
}

function getModel(index = 0) {
	const model = CLAUDE_CODE_MODELS[index];
	assert.ok(model);
	return model;
}

function getText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function createFakeCli(
	t: TestContext,
	scenarios: string[][],
	options: { releaseOnExtraUserLine?: boolean } = {},
): { runClaude: RunClaude; calls: FakeCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-keep-process-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const calls: FakeCall[] = [];
	t.after(async () => {
		for (const call of calls) {
			if (call.child.exitCode === null && call.child.signalCode === null) {
				call.child.kill("SIGKILL");
				await once(call.child, "close").catch(() => {});
			}
		}
	});

	const runClaude: RunClaude = (args, runOptions) => {
		const index = calls.length;
		const scenario = scenarios[index];
		assert.ok(scenario, `unexpected spawn #${index + 1}`);
		const scenarioFile = join(dir, `scenario-${index}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: runOptions.cwd,
			env: { ...runOptions.env, FAKE_CLAUDE_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;

		const userLines: string[] = [];
		let pending = "";
		const originalWrite = child.stdin.write.bind(child.stdin) as (...writeArgs: unknown[]) => boolean;
		child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
			pending += String(chunk);
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (line.trim()) {
					const parsed = JSON.parse(line) as { type?: string };
					if (parsed.type === "user") {
						userLines.push(line);
						if (options.releaseOnExtraUserLine && userLines.length > 1) {
							setImmediate(() => {
								if (child.exitCode === null && child.signalCode === null) child.send("continue");
							});
						}
					}
				}
				newline = pending.indexOf("\n");
			}
			return originalWrite(chunk, ...rest);
		}) as typeof child.stdin.write;

		calls.push({ args, cwd: runOptions.cwd, env: runOptions.env, child, userLines });
		return child;
	};

	return { runClaude, calls };
}

async function runTurn(
	streamFunction: StreamFunction<Api, SimpleStreamOptions>,
	messages: Message[],
	options?: SimpleStreamOptions & { systemPrompt?: string; tools?: Tool[]; modelIndex?: number },
): Promise<AssistantMessage> {
	const context = normalizeContext({
		systemPrompt: options?.systemPrompt ?? "You are a tutor.",
		messages,
		tools: options?.tools ?? [READ_TOOL],
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamFunction(getModel(options?.modelIndex), context, options)) {
		events.push(event);
	}
	const last = events.at(-1);
	assert.ok(last?.type === "done", `expected done, got ${last?.type}`);
	return last.message;
}

async function assertCleanedUp(call: FakeCall): Promise<void> {
	if (call.child.exitCode === null && call.child.signalCode === null) {
		await assert.doesNotReject(
			once(call.child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }),
			"claude CLI process was not killed",
		);
	}
	const privateDir = dirname(getFlagValue(call.args, "--system-prompt-file"));
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (existsSync(call.cwd) || existsSync(privateDir)) {
		assert.ok(Date.now() < deadline, "turn temp dirs were not removed");
		await sleep(10);
	}
}

function assertAlive(call: FakeCall): void {
	assert.equal(call.child.exitCode, null, "expected held process to stay alive");
	assert.equal(call.child.signalCode, null, "expected held process not to be signalled");
}

// plan 018 part 2: A stop turn with a sessionId leaves the process alive. The next request with one new learner message spawns no process and writes exactly one stdin line equal to toStreamJsonLine([{ type: "text", text }]).
test("stop turn with sessionId keeps process alive and continues with one user stdin line", async (t) => {
	const { runClaude, calls } = createFakeCli(
		t,
		[[...textTurn("first answer"), WAIT_FOR_MESSAGE, ...textTurn("second answer"), HOLD]],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "keep-stop" });
	assert.equal(first.stopReason, "stop");
	assert.equal(getText(first), "first answer");
	assert.equal(calls.length, 1);
	assertAlive(calls[0]!);

	const followUp: Message = { role: "user", content: "explain more", timestamp: 0 };
	const second = await runTurn(stream, [HI, first, followUp], { sessionId: "keep-stop" });
	assert.equal(calls.length, 1, "must reuse the held process without spawning");
	assert.equal(getText(second), "second answer");
	assert.equal(calls[0]!.userLines.length, 2);
	assert.equal(calls[0]!.userLines[1], toStreamJsonLine([{ type: "text", text: "explain more" }]));
});

// plan 018 part 2: Hold after length (max_tokens) and continue with a new user line.
test("length turn with sessionId keeps process alive and continues with one user stdin line", async (t) => {
	const { runClaude, calls } = createFakeCli(
		t,
		[[...textTurn("cut off", "max_tokens"), WAIT_FOR_MESSAGE, ...textTurn("continued"), HOLD]],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "keep-length" });
	assert.equal(first.stopReason, "length");
	assertAlive(calls[0]!);

	const second = await runTurn(stream, [HI, first, { role: "user", content: "go on", timestamp: 0 }], { sessionId: "keep-length" });
	assert.equal(calls.length, 1);
	assert.equal(getText(second), "continued");
	assert.equal(calls[0]!.userLines[1], toStreamJsonLine([{ type: "text", text: "go on" }]));
});

// plan 018 part 2: Two trailing user messages (the learner's text and an image) become one line with both blocks in order.
test("two trailing user messages (text and image) become one stdin line with both blocks in order", async (t) => {
	const { runClaude, calls } = createFakeCli(
		t,
		[[...textTurn("ready"), WAIT_FOR_MESSAGE, ...textTurn("saw image"), HOLD]],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "keep-two-user" });
	const textMsg: Message = { role: "user", content: "look at this diagram", timestamp: 0 };
	const imageMsg: Message = {
		role: "user",
		content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
		timestamp: 0,
	};

	const second = await runTurn(stream, [HI, first, textMsg, imageMsg], { sessionId: "keep-two-user" });
	assert.equal(calls.length, 1);
	assert.equal(getText(second), "saw image");
	assert.equal(calls[0]!.userLines.length, 2);
	assert.equal(
		calls[0]!.userLines[1],
		toStreamJsonLine([
			{ type: "text", text: "look at this diagram" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
		]),
	);
});

// plan 018 part 2: The CLI's result line after stop does not fail the held process.
test("CLI result line after stop does not fail the held process", async (t) => {
	const resultLine = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "first" });
	const { runClaude, calls } = createFakeCli(
		t,
		[[...textTurn("first"), resultLine, WAIT_FOR_MESSAGE, ...textTurn("second"), HOLD]],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "keep-result-line" });
	assert.equal(getText(first), "first");
	await sleep(50);
	assertAlive(calls[0]!);

	const second = await runTurn(stream, [HI, first, { role: "user", content: "next", timestamp: 0 }], { sessionId: "keep-result-line" });
	assert.equal(calls.length, 1);
	assert.equal(getText(second), "second");
});

// plan 018 part 2: Not continued, and replayed fresh in a new process: changed effort, model, system prompt or tools; an edited earlier message; a trailing toolResult; an assistant message after the snapshot.
for (const reason of [
	"effort",
	"model",
	"system prompt",
	"tools",
	"edited earlier message",
	"trailing toolResult",
	"assistant message after snapshot",
] as const) {
	test(`not continued and replayed fresh on ${reason}`, async (t) => {
		const { runClaude, calls } = createFakeCli(t, [
			[...textTurn("first"), HOLD],
			[...textTurn("fresh"), HOLD],
		]);
		const stream = createClaudeCodeStreamFunction(runClaude);
		const sessionId = `fresh-${reason}`;

		const first = await runTurn(stream, [HI], { sessionId });
		assertAlive(calls[0]!);

		const followUp: Message = { role: "user", content: "next", timestamp: 0 };
		let messages: Message[] = [HI, first, followUp];
		let options: SimpleStreamOptions & { systemPrompt?: string; tools?: Tool[]; modelIndex?: number } = { sessionId };

		switch (reason) {
			case "effort":
				options = { ...options, reasoning: "high" };
				break;
			case "model":
				options = { ...options, modelIndex: 1 };
				break;
			case "system prompt":
				options = { ...options, systemPrompt: "Different tutor prompt." };
				break;
			case "tools":
				options = { ...options, tools: [{ ...READ_TOOL, description: "Changed tool" }] };
				break;
			case "edited earlier message":
				messages = [{ role: "user", content: "edited hi", timestamp: 0 }, first, followUp];
				break;
			case "trailing toolResult": {
				const toolResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "toolu_stray",
					toolName: "read",
					content: [{ type: "text", text: "stray" }],
					isError: false,
					timestamp: 0,
				};
				messages = [HI, first, toolResult];
				break;
			}
			case "assistant message after snapshot":
				messages = [HI, first, { ...first, content: [{ type: "text", text: "extra assistant" }] }, followUp];
				break;
		}

		const second = await runTurn(stream, messages, options);
		assert.equal(calls.length, 2);
		assert.equal(getText(second), "fresh");
		await assertCleanedUp(calls[0]!);
	});
}

// plan 018 part 2: No sessionId: killed after stop as today.
test("no sessionId kills process after stop", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [[...textTurn("done"), HOLD]]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const reply = await runTurn(stream, [HI], { sessionId: undefined });
	assert.equal(reply.stopReason, "stop");
	await assertCleanedUp(calls[0]!);
});

// plan 018 part 2: An error turn is killed.
test("error turn kills process", async (t) => {
	const resultError = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
	const { runClaude, calls } = createFakeCli(t, [[resultError, HOLD]]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const events: AssistantMessageEvent[] = [];
	for await (const event of stream(getModel(), normalizeContext({ messages: [HI] }), { sessionId: "err-chat" })) {
		events.push(event);
	}
	assert.equal(events.at(-1)?.type, "error");
	await assertCleanedUp(calls[0]!);
});

// plan 018 part 2: An aborted turn is killed.
test("aborted turn kills process", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [[streamEvent({ type: "message_start", message: { usage: {} } }), HOLD]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const controller = new AbortController();

	const events: AssistantMessageEvent[] = [];
	for await (const event of stream(getModel(), normalizeContext({ messages: [HI] }), {
		sessionId: "abort-turn",
		signal: controller.signal,
	})) {
		events.push(event);
		if (event.type === "start") controller.abort();
	}
	const last = events.at(-1);
	assert.ok(last?.type === "error" && last.reason === "aborted");
	await assertCleanedUp(calls[0]!);
});

// plan 018 part 2: A second finished turn in the same session replaces the held process; the old one is killed.
test("second finished turn in the same session replaces held process and kills old one", async (t) => {
	const { runClaude, calls } = createFakeCli(
		t,
		[
			[...textTurn("one"), HOLD],
			[...textTurn("two"), WAIT_FOR_MESSAGE, ...textTurn("three"), HOLD],
		],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const sessionId = "replace-session";

	const one = await runTurn(stream, [HI], { sessionId, systemPrompt: "Prompt A" });
	assertAlive(calls[0]!);

	const two = await runTurn(stream, [HI, one, { role: "user", content: "second", timestamp: 0 }], {
		sessionId,
		systemPrompt: "Prompt B",
	});
	assert.equal(calls.length, 2);
	await assertCleanedUp(calls[0]!);
	assertAlive(calls[1]!);

	const three = await runTurn(
		stream,
		[HI, one, { role: "user", content: "second", timestamp: 0 }, two, { role: "user", content: "third", timestamp: 0 }],
		{ sessionId, systemPrompt: "Prompt B" },
	);
	assert.equal(calls.length, 2);
	assert.equal(getText(three), "three");
});

// plan 018 part 2: Cap of 3 held processes app-wide; holding a 4th kills the longest-idle one and keeps the other 3. A process waiting for tool results counts.
test("cap of 3: holding a 4th process kills the longest-idle one and keeps the other 3 (waiting for tool results counts)", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [
		[...textTurn("s1"), HOLD],
		[...textTurn("s2"), HOLD],
		[...toolUseTurn("toolu_cap_3", "read", { path: "a" }), HOLD],
		[...textTurn("s4"), HOLD],
	]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	await runTurn(stream, [HI], { sessionId: "cap-1" });
	await runTurn(stream, [HI], { sessionId: "cap-2" });
	await runTurn(stream, [HI], { sessionId: "cap-3" });
	assert.equal(calls.length, 3);
	for (const call of calls) assertAlive(call);

	await runTurn(stream, [HI], { sessionId: "cap-4" });
	assert.equal(calls.length, 4);
	await assertCleanedUp(calls[0]!);
	assertAlive(calls[1]!);
	assertAlive(calls[2]!);
	assertAlive(calls[3]!);
});

// plan 018 part 2: Cap of 3: a process waiting for tool results that is longest-idle is evicted when a 4th process is held.
test("cap of 3: longest-idle tool-waiting process is evicted when a 4th process is held", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [
		[...toolUseTurn("toolu_cap_first", "read", { path: "a" }), HOLD],
		[...textTurn("s2"), HOLD],
		[...textTurn("s3"), HOLD],
		[...textTurn("s4"), HOLD],
	]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	await runTurn(stream, [HI], { sessionId: "cap-tool-1" });
	await runTurn(stream, [HI], { sessionId: "cap-tool-2" });
	await runTurn(stream, [HI], { sessionId: "cap-tool-3" });
	await runTurn(stream, [HI], { sessionId: "cap-tool-4" });

	assert.equal(calls.length, 4);
	await assertCleanedUp(calls[0]!);
	assertAlive(calls[1]!);
	assertAlive(calls[2]!);
	assertAlive(calls[3]!);
});

// plan 018 part 2: Cap of 3: holding a 4th kills the one idle longest, so continuing the first held process refreshes it and the second is evicted instead.
test("cap of 3: continuing the first held process makes the second the longest-idle one", async (t) => {
	const { runClaude, calls } = createFakeCli(
		t,
		[
			[...textTurn("s1"), WAIT_FOR_MESSAGE, ...textTurn("s1 again"), HOLD],
			[...textTurn("s2"), HOLD],
			[...textTurn("s3"), HOLD],
			[...textTurn("s4"), HOLD],
		],
		{ releaseOnExtraUserLine: true },
	);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "cap-refresh-1" });
	await runTurn(stream, [HI], { sessionId: "cap-refresh-2" });
	await runTurn(stream, [HI], { sessionId: "cap-refresh-3" });
	await runTurn(stream, [HI, first, { role: "user", content: "again", timestamp: 0 }], { sessionId: "cap-refresh-1" });
	assert.equal(calls.length, 3, "continuation must reuse the first process");

	await runTurn(stream, [HI], { sessionId: "cap-refresh-4" });
	assert.equal(calls.length, 4);
	await assertCleanedUp(calls[1]!);
	assertAlive(calls[0]!);
	assertAlive(calls[2]!);
	assertAlive(calls[3]!);
});

// plan 018 part 2: At most 3 held processes app-wide, across all stream functions.
test("cap of 3 is app-wide: a 4th process on one stream function evicts the longest-idle one of another", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [
		[...textTurn("a1"), HOLD],
		[...textTurn("a2"), HOLD],
		[...textTurn("b1"), HOLD],
		[...textTurn("b2"), HOLD],
	]);
	const streamA = createClaudeCodeStreamFunction(runClaude);
	const streamB = createClaudeCodeStreamFunction(runClaude);

	await runTurn(streamA, [HI], { sessionId: "cap-app-a1" });
	await runTurn(streamA, [HI], { sessionId: "cap-app-a2" });
	await runTurn(streamB, [HI], { sessionId: "cap-app-b1" });
	assert.equal(calls.length, 3);
	for (const call of calls) assertAlive(call);

	await runTurn(streamB, [HI], { sessionId: "cap-app-b2" });
	assert.equal(calls.length, 4);
	await assertCleanedUp(calls[0]!);
	assertAlive(calls[1]!);
	assertAlive(calls[2]!);
	assertAlive(calls[3]!);
});

// plan 018 part 2: Idle: the held process is killed after liveProcessIdleTimeoutMs.current (seam), and the next turn replays fresh.
test("idle timeout kills held process and next turn replays fresh", async (t) => {
	liveProcessIdleTimeoutMs.current = 100;
	t.after(() => {
		liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS;
	});

	const { runClaude, calls } = createFakeCli(t, [
		[...textTurn("first"), HOLD],
		[...textTurn("replayed"), HOLD],
	]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI], { sessionId: "idle-stop" });
	await assertCleanedUp(calls[0]!);

	const second = await runTurn(stream, [HI, first, { role: "user", content: "after idle", timestamp: 0 }], {
		sessionId: "idle-stop",
	});
	assert.equal(calls.length, 2);
	assert.equal(getText(second), "replayed");
});

// plan 018 part 2: The MCP_TOOL_TIMEOUT env equals 3600000 and is greater than the idle limit (50 minutes = 3000000).
test("MCP_TOOL_TIMEOUT equals 3600000 and is greater than LIVE_PROCESS_IDLE_TIMEOUT_MS", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [[...textTurn("ok"), HOLD]]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	await runTurn(stream, [HI], { sessionId: "timeout-env" });
	const call = calls[0]!;
	assert.equal(call.env.MCP_TOOL_TIMEOUT, "3600000");
	assert.equal(LIVE_PROCESS_IDLE_TIMEOUT_MS, 3000000);
	assert.ok(Number(call.env.MCP_TOOL_TIMEOUT) > LIVE_PROCESS_IDLE_TIMEOUT_MS);
});

// plan 018 part 2: Abort while held kills the process.
test("abort while held kills the process", async (t) => {
	const { runClaude, calls } = createFakeCli(t, [[...textTurn("held"), HOLD]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const controller = new AbortController();

	await runTurn(stream, [HI], { sessionId: "abort-held", signal: controller.signal });
	assertAlive(calls[0]!);

	controller.abort();
	await assertCleanedUp(calls[0]!);
});
