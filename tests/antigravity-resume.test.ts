import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AGY_WORKSPACES_DIR } from "../config.ts";
import { deleteLink, readLink, removeWorkspace, workspaceFor } from "../src/agent/antigravity/link.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { AGY_TRANSCRIPT_END, buildAntigravityResumePrompt } from "../src/agent/antigravity/request.ts";
import { ANTIGRAVITY_FALLBACK_MODEL, createAntigravityStream, type RunAntigravity } from "../src/agent/antigravity/stream.ts";

const defaultModel = ANTIGRAVITY_MODELS[0]!;
const hydrogenModel = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
const sonnetModel = ANTIGRAVITY_MODELS.find((m) => m.id === ANTIGRAVITY_FALLBACK_MODEL)!;
const quizTool: Tool = {
	name: "quiz",
	description: "Ask a quiz",
	parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
};

const createdChats: string[] = [];

function trackChat(chatId: string): string {
	createdChats.push(chatId);
	return chatId;
}

afterEach(() => {
	while (createdChats.length > 0) {
		const id = createdChats.pop()!;
		try {
			removeWorkspace(id);
		} catch {
			// Best-effort cleanup.
		}
	}
});

interface FakeCall {
	args: string[];
	cwd: string;
	prompt: string;
	settings: Record<string, unknown>;
	filesAtSpawn: string[];
}

interface FakeStep {
	conversationId?: string;
	steps?: { input_tokens: number; output_tokens: number; cache_read_tokens: number }[];
	result: Record<string, unknown>;
	code?: number;
	hold?: Promise<void>;
	onSpawn?: (cwd: string) => void;
}

function fakeSequence(sequence: FakeStep[]) {
	const calls: FakeCall[] = [];
	let index = 0;
	const run: RunAntigravity = (_binary, args, options) => {
		const step = sequence[index++];
		assert.ok(step, `unexpected run #${index}`);
		assert.equal(fs.statSync(options.cwd).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(options.cwd, "request.txt")).mode & 0o777, 0o600);
		step.onSpawn?.(options.cwd);
		calls.push({
			args,
			cwd: options.cwd,
			prompt: fs.readFileSync(path.join(options.cwd, "request.txt"), "utf8"),
			settings: JSON.parse(args[args.indexOf("--settings") + 1]!),
			filesAtSpawn: fs.readdirSync(options.cwd),
		});
		const lines = [
			...(step.conversationId ? [JSON.stringify({ event: "init", conversation_id: step.conversationId })] : []),
			...(step.steps ?? []).map((usage) => JSON.stringify({ event: "step_update", usage })),
			JSON.stringify({ event: "result", result: step.result }),
		].join("\n") + "\n";

		if (step.hold) {
			const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"], { stdio: "pipe" });
			void step.hold.then(() => {
				child.stdout.push(lines);
				child.stdout.push(null);
				child.kill("SIGTERM");
			});
			// Replace child with a process that writes lines and exits once hold resolves.
			child.kill("SIGKILL");
			const gated = spawn(
				process.execPath,
				[
					"-e",
					`const fs = require('fs'); process.stdin.resume(); process.stdin.on('data', () => {});` +
					`const timer = setInterval(() => {}, 1000);` +
					`process.on('SIGUSR1', () => { clearInterval(timer); process.stdout.write(${JSON.stringify(lines)}); process.exit(${step.code ?? 0}); });`,
				],
				{ stdio: "pipe" },
			);
			void step.hold.then(() => {
				gated.kill("SIGUSR1");
			});
			return gated;
		}

		return spawn(
			process.execPath,
			[
				"-e",
				`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(lines)}); process.exitCode=${step.code ?? 0}; });`,
			],
			{ stdio: "pipe" },
		);
	};
	return { run, calls };
}

function successStep(text: string, conversationId = "conv-1", usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 }): FakeStep {
	return {
		conversationId,
		steps: [usage],
		result: { status: "SUCCESS", structured_output: { text, toolCalls: [] }, usage },
	};
}

function assistantMsg(text: string, toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []): AssistantMessage {
	return {
		role: "assistant",
		// @ts-expect-error locked test helper types toolCalls.arguments as Record<string, unknown> instead of JsonObject
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...toolCalls.map((call) => ({ type: "toolCall" as const, ...call })),
		],
		api: "antigravity-cli",
		provider: "antigravity",
		model: "default",
		stopReason: toolCalls.length ? "toolUse" : "stop",
		timestamp: 2000,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function argValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx === -1 ? undefined : args[idx + 1];
}

describe("antigravity resume prompt", () => {
	// plan 019 part 2: prompt is [user]\n<text> + AGY_TRANSCRIPT_END, with no instructions or tool list
	it("formats a single trailing user message as [user] + AGY_TRANSCRIPT_END without instructions or tools", () => {
		const user: UserMessage = { role: "user", content: "What is 2+2?", timestamp: 1000 };
		const { prompt, images } = buildAntigravityResumePrompt([user], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.deepEqual(images, []);
		assert.equal(prompt, `[user]\nWhat is 2+2?\n\n${AGY_TRANSCRIPT_END}`);
		assert.equal(prompt.includes("Available harness tools"), false);
		assert.equal(prompt.includes("inference engine"), false);
	});

	// plan 019 part 2: a tool round trip holds [tool result <name>]\n<text>
	it("formats tool results with [tool result <name>] and error suffix when isError is true", () => {
		const okResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "quiz",
			content: [{ type: "text", text: "Answer 2 is correct" }],
			isError: false,
			timestamp: 3000,
		};
		const { prompt } = buildAntigravityResumePrompt([okResult], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.ok(prompt.includes("[tool result quiz]\nAnswer 2 is correct"));
		assert.ok(prompt.endsWith(AGY_TRANSCRIPT_END));

		const errResult: ToolResultMessage = { ...okResult, isError: true, content: [{ type: "text", text: "boom" }] };
		const { prompt: errPrompt } = buildAntigravityResumePrompt([errResult], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.ok(errPrompt.includes("[tool result quiz error]\nboom"));
	});
});

describe("antigravity resume stream", () => {
	// plan 019 part 2: first turn of a chat: full prompt, no --conversation, cwd = the chat's workspace, link written with init conversation_id
	it("first turn uses chat workspace, sends full prompt without --conversation, and writes link from init conversation_id", async () => {
		const chatId = trackChat("chat_resume_first_1");
		const { run, calls } = fakeSequence([successStep("Hello learner", "conv-first-1")]);
		const ctx = normalizeContext({
			systemPrompt: "Teach carefully",
			tools: [quizTool],
			messages: [{ role: "user", content: "Teach addition", timestamp: 1000 }],
		});
		const stream = createAntigravityStream(run, () => "/fake/agy")(defaultModel, ctx, { sessionId: chatId });
		for await (const _ of stream) { /* drain */ }
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.cwd, workspaceFor(chatId));
		assert.equal(fs.existsSync(calls[0]!.cwd), true);
		assert.equal(argValue(calls[0]!.args, "--conversation"), undefined);
		assert.ok(calls[0]!.prompt.includes("Teach carefully"));
		assert.ok(calls[0]!.prompt.includes("Available harness tools"));
		assert.ok(calls[0]!.prompt.includes("Teach addition"));
		assert.ok(calls[0]!.prompt.includes(AGY_TRANSCRIPT_END));
		assert.equal(readLink(chatId)?.conversationId, "conv-first-1");
		// plan 019 part 2: the link is written with the model and messageCount
		const raw = JSON.parse(fs.readFileSync(path.join(AGY_WORKSPACES_DIR, chatId, "link.json"), "utf8")) as Record<string, unknown>;
		assert.equal(raw.conversationId, "conv-first-1");
		assert.equal(raw.model, defaultModel.id);
		assert.equal(raw.messageCount, 1);
	});

	// plan 019 part 2: next request with one new user message: args contain --conversation <id>, prompt is [user]\n<text> + AGY_TRANSCRIPT_END, same cwd
	it("resumes with --conversation and sends only [user]\\n<text> + AGY_TRANSCRIPT_END on the next turn", async () => {
		const chatId = trackChat("chat_resume_next_1");
		const { run, calls } = fakeSequence([
			successStep("First reply", "conv-next-1"),
			successStep("Second reply", "conv-next-1"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Teach addition", timestamp: 1000 };
		const ctx1 = normalizeContext({ systemPrompt: "Teach carefully", tools: [quizTool], messages: [msg1] });
		await streamFn(defaultModel, ctx1, { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "What is 1+1?", timestamp: 3000 };
		const ctx2 = normalizeContext({
			systemPrompt: "Teach carefully",
			tools: [quizTool],
			messages: [msg1, assistantMsg("First reply"), msg2],
		});
		await streamFn(defaultModel, ctx2, { sessionId: chatId }).result();

		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.cwd, calls[0]!.cwd);
		assert.equal(argValue(calls[1]!.args, "--conversation"), "conv-next-1");
		assert.equal(calls[1]!.prompt, `[user]\nWhat is 1+1?\n\n${AGY_TRANSCRIPT_END}`);
		assert.equal(calls[1]!.prompt.includes("Teach carefully"), false);
		assert.equal(calls[1]!.prompt.includes("Available harness tools"), false);
		assert.equal(calls[1]!.prompt.includes("Teach addition"), false);
	});

	// plan 019 part 2: a tool round trip: the resumed prompt holds [tool result <name>]\n<text>
	it("sends [tool result <name>]\\n<text> in the resumed prompt on a tool round trip", async () => {
		const chatId = trackChat("chat_resume_tool_1");
		const { run, calls } = fakeSequence([
			{
				conversationId: "conv-tool-1",
				steps: [{ input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 }],
				result: { status: "SUCCESS", structured_output: { text: "", toolCalls: [{ name: "quiz", arguments: { question: "1+1?" } }] } },
			},
			successStep("Great job!", "conv-tool-1"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Quiz me", timestamp: 1000 };
		const ctx1 = normalizeContext({ systemPrompt: "Teach carefully", tools: [quizTool], messages: [msg1] });
		const res1 = await streamFn(defaultModel, ctx1, { sessionId: chatId }).result();
		const toolCall = res1.content.find((b) => b.type === "toolCall")!;
		assert.equal(toolCall.type, "toolCall");

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: "quiz",
			content: [{ type: "text", text: "2" }],
			isError: false,
			timestamp: 3000,
		};
		const ctx2 = normalizeContext({
			systemPrompt: "Teach carefully",
			tools: [quizTool],
			messages: [msg1, res1, toolResult],
		});
		await streamFn(defaultModel, ctx2, { sessionId: chatId }).result();

		assert.equal(calls.length, 2);
		assert.equal(argValue(calls[1]!.args, "--conversation"), "conv-tool-1");
		assert.ok(calls[1]!.prompt.includes("[tool result quiz]\n2"));
		assert.ok(calls[1]!.prompt.includes(AGY_TRANSCRIPT_END));
		assert.equal(calls[1]!.prompt.includes("Teach carefully"), false);
	});

	// plan 019 part 2: fresh replay and a new link on model change
	it("falls back to fresh replay and writes a new link when the model changes", async () => {
		const chatId = trackChat("chat_resume_model_change");
		const { run, calls } = fakeSequence([
			successStep("From default", "conv-m1"),
			successStep("From hydrogen", "conv-m2"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		await streamFn(
			hydrogenModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("From default"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(argValue(calls[1]!.args, "--conversation"), undefined);
		assert.ok(calls[1]!.prompt.includes("Sys"));
		assert.ok(calls[1]!.prompt.includes("Hi"));
		assert.equal(readLink(chatId)?.conversationId, "conv-m2");
	});

	// plan 019 part 2: fresh replay and a new link on system prompt change
	it("falls back to fresh replay and writes a new link when the system prompt changes", async () => {
		const chatId = trackChat("chat_resume_sys_change");
		const { run, calls } = fakeSequence([
			successStep("First", "conv-s1"),
			successStep("Second", "conv-s2"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys A", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		await streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys B", tools: [quizTool], messages: [msg1, assistantMsg("First"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(argValue(calls[1]!.args, "--conversation"), undefined);
		assert.ok(calls[1]!.prompt.includes("Sys B"));
		assert.equal(readLink(chatId)?.conversationId, "conv-s2");
	});

	// plan 019 part 2: fresh replay and a new link on tools change
	it("falls back to fresh replay and writes a new link when tools change", async () => {
		const chatId = trackChat("chat_resume_tools_change");
		const { run, calls } = fakeSequence([
			successStep("First", "conv-t1"),
			successStep("Second", "conv-t2"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		await streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [], messages: [msg1, assistantMsg("First"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(argValue(calls[1]!.args, "--conversation"), undefined);
		assert.ok(calls[1]!.prompt.includes("Sys"));
		assert.equal(readLink(chatId)?.conversationId, "conv-t2");
	});

	// plan 019 part 2: fresh replay and a new link on edited earlier message
	it("falls back to fresh replay and writes a new link when an earlier message is edited", async () => {
		const chatId = trackChat("chat_resume_edited_msg");
		const { run, calls } = fakeSequence([
			successStep("First", "conv-e1"),
			successStep("Second", "conv-e2"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Original", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const edited1: UserMessage = { role: "user", content: "Edited", timestamp: 1000 };
		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		await streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [edited1, assistantMsg("First"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(argValue(calls[1]!.args, "--conversation"), undefined);
		assert.ok(calls[1]!.prompt.includes("Edited"));
		assert.equal(readLink(chatId)?.conversationId, "conv-e2");
	});

	// plan 019 part 2: fresh replay and a new link on missing or corrupt link
	it("falls back to fresh replay and writes a new link when the link is missing or corrupt", async () => {
		const chatMissing = trackChat("chat_resume_missing_link");
		const seqMissing = fakeSequence([
			successStep("First", "conv-miss-1"),
			successStep("Second", "conv-miss-2"),
		]);
		const streamMissing = createAntigravityStream(seqMissing.run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		await streamMissing(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatMissing }).result();
		deleteLink(chatMissing);
		await streamMissing(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("First"), msg2] }), { sessionId: chatMissing }).result();
		assert.equal(argValue(seqMissing.calls[1]!.args, "--conversation"), undefined);
		assert.ok(seqMissing.calls[1]!.prompt.includes("Sys"));
		assert.equal(readLink(chatMissing)?.conversationId, "conv-miss-2");

		const chatCorrupt = trackChat("chat_resume_corrupt_link");
		const seqCorrupt = fakeSequence([
			successStep("First", "conv-corr-1"),
			successStep("Second", "conv-corr-2"),
		]);
		const streamCorrupt = createAntigravityStream(seqCorrupt.run, () => "/fake/agy");
		await streamCorrupt(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatCorrupt }).result();
		const linkFile = path.join(AGY_WORKSPACES_DIR, chatCorrupt, "link.json");
		fs.writeFileSync(linkFile, "{corrupt json", "utf8");
		await streamCorrupt(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("First"), msg2] }), { sessionId: chatCorrupt }).result();
		assert.equal(argValue(seqCorrupt.calls[1]!.args, "--conversation"), undefined);
		assert.ok(seqCorrupt.calls[1]!.prompt.includes("Sys"));
		assert.equal(readLink(chatCorrupt)?.conversationId, "conv-corr-2");
	});

	// plan 019 part 2: unusable first run: the link is deleted, the fallback runs without --conversation, and its id becomes the link with model claude-sonnet-5-5
	it("deletes the link on an unusable first run, retries fallback without --conversation, and links the fallback id", async () => {
		const chatId = trackChat("chat_resume_unusable_fallback");
		let linkAtFallbackSpawn: unknown = "unset";
		const { run, calls } = fakeSequence([
			successStep("First", "conv-orig"),
			{
				conversationId: "conv-orig",
				steps: [{ input_tokens: 50, output_tokens: 10, cache_read_tokens: 0 }],
				result: { status: "SUCCESS", structured_output: undefined },
			},
			{ ...successStep("Fallback answer", "conv-fallback"), onSpawn: () => { linkAtFallbackSpawn = readLink(chatId); } },
			successStep("Turn 3", "conv-fallback"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(hydrogenModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		const res2 = await streamFn(
			hydrogenModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("First"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(res2.stopReason, "stop");
		assert.equal(res2.model, "claude-sonnet-5-5");
		assert.equal(argValue(calls[1]!.args, "--conversation"), "conv-orig");
		assert.equal(argValue(calls[2]!.args, "--conversation"), undefined);
		assert.equal(argValue(calls[2]!.args, "--model"), "claude-sonnet-5-5");
		assert.equal(linkAtFallbackSpawn, null);
		assert.ok(calls[2]!.prompt.includes("Sys"));
		assert.ok(calls[2]!.prompt.includes("Hi"));
		assert.ok(calls[2]!.prompt.includes("Available harness tools"));
		assert.equal(readLink(chatId)?.conversationId, "conv-fallback");
		const rawFallback = JSON.parse(fs.readFileSync(path.join(AGY_WORKSPACES_DIR, chatId, "link.json"), "utf8")) as Record<string, unknown>;
		assert.equal(rawFallback.model, "claude-sonnet-5-5");

		// Subsequent turn on claude-sonnet-5-5 resumes the fallback conversation.
		const msg3: UserMessage = { role: "user", content: "More", timestamp: 5000 };
		await streamFn(
			sonnetModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("First"), msg2, res2, msg3] }),
			{ sessionId: chatId },
		).result();
		assert.equal(argValue(calls[3]!.args, "--conversation"), "conv-fallback");
	});

	// plan 019 part 2: usage: two step_update usage events are summed; a cumulative result.usage is ignored
	it("sums usage across step_update events and ignores cumulative result.usage", async () => {
		const chatId = trackChat("chat_resume_usage_1");
		const { run } = fakeSequence([
			{
				conversationId: "conv-usage-1",
				steps: [
					{ input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 },
					{ input_tokens: 250, output_tokens: 45, cache_read_tokens: 50 },
				],
				result: {
					status: "SUCCESS",
					structured_output: { text: "Done", toolCalls: [] },
					usage: { input_tokens: 9999, output_tokens: 9999, cache_read_tokens: 9999 },
				},
			},
		]);
		const ctx = normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [{ role: "user", content: "Hi", timestamp: 1000 }] });
		const result = await createAntigravityStream(run, () => "/fake/agy")(defaultModel, ctx, { sessionId: chatId }).result();

		assert.equal(result.usage.input, 270);
		assert.equal(result.usage.output, 65);
		assert.equal(result.usage.cacheRead, 80);
		assert.equal(result.usage.totalTokens, 415);
	});

	// plan 019 part 2: no sessionId: temporary folder, removed after the run; no link
	it("uses a temporary folder removed after the run and writes no link when sessionId is omitted", async () => {
		const { run, calls } = fakeSequence([successStep("Done", "conv-anon")]);
		const ctx = normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [{ role: "user", content: "Hi", timestamp: 1000 }] });
		const stream = createAntigravityStream(run, () => "/fake/agy")(defaultModel, ctx);
		for await (const _ of stream) { /* drain */ }
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.ok(path.basename(calls[0]!.cwd).startsWith("learnharness-agy-"));
		assert.ok(!path.relative(tmpdir(), calls[0]!.cwd).startsWith(".."));
		assert.equal(fs.existsSync(calls[0]!.cwd), false);
		assert.equal(argValue(calls[0]!.args, "--conversation"), undefined);
		const chatDirs = fs.existsSync(AGY_WORKSPACES_DIR)
			? fs.readdirSync(AGY_WORKSPACES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
			: [];
		for (const dir of chatDirs) {
			const linkFile = path.join(AGY_WORKSPACES_DIR, dir, "link.json");
			if (fs.existsSync(linkFile)) assert.equal(fs.readFileSync(linkFile, "utf8").includes("conv-anon"), false);
		}
	});

	// plan 019 part 2: image in a resumed message: written into the workspace, referenced in the prompt, removed after the run
	it("writes resumed images into the workspace, references them in the prompt, and removes them after the run", async () => {
		const chatId = trackChat("chat_resume_image_1");
		const { run, calls } = fakeSequence([
			successStep("First", "conv-img-1"),
			successStep("Saw it", "conv-img-1"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const imgMsg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "What is this?" },
				{ type: "image", mimeType: "image/png", data: Buffer.from("fake-png-data").toString("base64") },
			],
			timestamp: 3000,
		};
		const stream2 = streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("First"), imgMsg] }),
			{ sessionId: chatId },
		);
		for await (const _ of stream2) { /* drain */ }
		const res2 = await stream2.result();

		assert.equal(res2.stopReason, "stop");
		assert.equal(argValue(calls[1]!.args, "--conversation"), "conv-img-1");
		assert.equal(calls[1]!.prompt.includes("Sys"), false);
		const ws = workspaceFor(chatId);
		const imgFilesAtSpawn = calls[1]!.filesAtSpawn.filter((name) => name.endsWith(".png"));
		assert.equal(imgFilesAtSpawn.length, 1);
		const imgPath = path.join(ws, imgFilesAtSpawn[0]!);
		assert.ok(calls[1]!.prompt.includes(imgPath));
		assert.equal(fs.existsSync(imgPath), false);
		assert.equal(fs.existsSync(ws), true);
	});

	// plan 019 part 2: concurrent run for the same chat: full replay, and the link is left unchanged
	it("runs a concurrent request for the same chat as a full replay and leaves the link unchanged", async () => {
		const chatId = trackChat("chat_resume_concurrent_1");
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let spawn2Started!: () => void;
		const waitSpawn2 = new Promise<void>((resolve) => { spawn2Started = resolve; });

		const { run, calls } = fakeSequence([
			successStep("Initial", "conv-conc-1"),
			{
				conversationId: "conv-conc-1",
				steps: [{ input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 }],
				result: { status: "SUCCESS", structured_output: { text: "In flight", toolCalls: [] } },
				hold: firstGate,
				onSpawn: () => spawn2Started(),
			},
			successStep("Concurrent", "conv-concurrent-ignored"),
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Primary turn", timestamp: 3000 };
		const inFlight = streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("Initial"), msg2] }),
			{ sessionId: chatId },
		);
		await waitSpawn2;

		const msgConcurrent: UserMessage = { role: "user", content: "Concurrent turn", timestamp: 3500 };
		const concurrentRes = await streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, assistantMsg("Initial"), msgConcurrent] }),
			{ sessionId: chatId },
		).result();

		assert.equal(concurrentRes.stopReason, "stop");
		assert.equal(argValue(calls[2]!.args, "--conversation"), undefined);
		assert.ok(calls[2]!.prompt.includes("Sys"));
		assert.ok(calls[2]!.prompt.includes("Concurrent turn"));
		assert.equal(readLink(chatId)?.conversationId, "conv-conc-1");

		releaseFirst();
		const primaryRes = await inFlight.result();
		assert.equal(primaryRes.stopReason, "stop");
		assert.equal(readLink(chatId)?.conversationId, "conv-conc-1");
	});
});
