import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { readLink, removeWorkspace, writeLink } from "../src/agent/antigravity/link.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { AGY_TRANSCRIPT_END, buildAntigravityResumePrompt } from "../src/agent/antigravity/request.ts";
import { createAntigravityStream, type RunAntigravity } from "../src/agent/antigravity/stream.ts";

const defaultModel = ANTIGRAVITY_MODELS[0]!;
const hydrogenModel = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
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
	prompt: string;
}

interface FakeStep {
	conversationId?: string;
	result: Record<string, unknown>;
}

function fakeSequence(sequence: FakeStep[]) {
	const calls: FakeCall[] = [];
	let index = 0;
	const run: RunAntigravity = (_binary, args, options) => {
		const step = sequence[index++];
		assert.ok(step, `unexpected run #${index}`);
		calls.push({
			args,
			prompt: fs.readFileSync(path.join(options.cwd, "request.txt"), "utf8"),
		});
		const lines =
			[
				...(step.conversationId ? [JSON.stringify({ event: "init", conversation_id: step.conversationId })] : []),
				JSON.stringify({ event: "step_update", usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 } }),
				JSON.stringify({ event: "result", result: step.result }),
			].join("\n") + "\n";
		return spawn(
			process.execPath,
			[
				"-e",
				`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(lines)}); process.exitCode=0; });`,
			],
			{ stdio: "pipe" },
		);
	};
	return { run, calls };
}

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "antigravity-cli",
		provider: "antigravity",
		model: "default",
		stopReason: "stop",
		timestamp: 2000,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function argValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx === -1 ? undefined : args[idx + 1];
}

describe("antigravity link validation edge cases", () => {
	it("preserves messageCount of 0 when reading a link", () => {
		const chatId = trackChat("chat_edge_zero_count");
		writeLink(chatId, { conversationId: "conv-zero", fingerprint: "fp-zero", model: "default", messageCount: 0 });
		const link = readLink(chatId);
		assert.equal(link?.messageCount, 0);
	});

	it("drops an empty model string when reading a link", () => {
		const chatId = trackChat("chat_edge_empty_model");
		writeLink(chatId, { conversationId: "conv-blank", fingerprint: "fp-blank", model: "", messageCount: 1 });
		const link = readLink(chatId);
		assert.ok(link);
		assert.equal(link.model, undefined);
		assert.equal("model" in link, false);
	});

	it("drops a non-integer messageCount when reading a link", () => {
		const chatId = trackChat("chat_edge_frac_count");
		writeLink(chatId, { conversationId: "conv-frac", fingerprint: "fp-frac", model: "default", messageCount: 2.5 });
		const link = readLink(chatId);
		assert.ok(link);
		assert.equal(link.messageCount, undefined);
		assert.equal("messageCount" in link, false);
	});
});

describe("antigravity resume prompt edge cases", () => {
	it("keeps the role or tool label line for image-only user and toolResult messages", () => {
		const userImgOnly: UserMessage = {
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "YWJj" }],
			timestamp: 1000,
		};
		const userBuilt = buildAntigravityResumePrompt([userImgOnly], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.equal(userBuilt.prompt, `[user]\n\n[Image: read this file to see the supplied image: /ws/input-0.png]\n\n${AGY_TRANSCRIPT_END}`);

		const toolImgOnly: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-img",
			toolName: "quiz",
			content: [{ type: "image", mimeType: "image/png", data: "YWJj" }],
			isError: false,
			timestamp: 2000,
		};
		const toolBuilt = buildAntigravityResumePrompt([toolImgOnly], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.equal(toolBuilt.prompt, `[tool result quiz]\n\n[Image: read this file to see the supplied image: /ws/input-0.png]\n\n${AGY_TRANSCRIPT_END}`);
	});

	it("includes JSON-serialized toolCall arguments in resumed assistant turns", () => {
		const assistantWithCall: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check" },
				{ type: "toolCall", id: "tc-1", name: "quiz", arguments: { question: "2+2?" } },
			],
			api: "antigravity-cli",
			provider: "antigravity",
			model: "default",
			stopReason: "toolUse",
			timestamp: 2000,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const { prompt } = buildAntigravityResumePrompt([assistantWithCall], (i, ext) => `/ws/input-${i}.${ext}`);
		assert.ok(prompt.includes("[assistant]\nLet me check"));
		assert.ok(prompt.includes('[tool call quiz] {"question":"2+2?"}'));
		assert.ok(prompt.endsWith(AGY_TRANSCRIPT_END));
	});
});

describe("antigravity resume stream edge cases", () => {
	it("does not resume when no new message follows the assistant reply", async () => {
		const chatId = trackChat("chat_edge_no_trailing");
		const { run, calls } = fakeSequence([
			{ conversationId: "conv-no-trail-1", result: { status: "SUCCESS", structured_output: { text: "First", toolCalls: [] } } },
			{ conversationId: "conv-no-trail-2", result: { status: "SUCCESS", structured_output: { text: "Replay", toolCalls: [] } } },
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(defaultModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		await streamFn(
			defaultModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, makeAssistant("First")] }),
			{ sessionId: chatId },
		).result();

		assert.equal(calls.length, 2);
		assert.equal(argValue(calls[1]!.args, "--conversation"), undefined);
		assert.ok(calls[1]!.prompt.includes("Sys"));
	});

	it("does not reuse the old resumed conversationId when fallback reports no init conversation_id", async () => {
		const chatId = trackChat("chat_edge_fallback_no_id");
		const { run, calls } = fakeSequence([
			{ conversationId: "conv-orig-id", result: { status: "SUCCESS", structured_output: { text: "First", toolCalls: [] } } },
			{ conversationId: "conv-orig-id", result: { status: "SUCCESS", structured_output: undefined } },
			{ result: { status: "SUCCESS", structured_output: { text: "Fallback", toolCalls: [] } } },
		]);
		const streamFn = createAntigravityStream(run, () => "/fake/agy");
		const msg1: UserMessage = { role: "user", content: "Hi", timestamp: 1000 };
		await streamFn(hydrogenModel, normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1] }), { sessionId: chatId }).result();

		const msg2: UserMessage = { role: "user", content: "Next", timestamp: 3000 };
		const res2 = await streamFn(
			hydrogenModel,
			normalizeContext({ systemPrompt: "Sys", tools: [quizTool], messages: [msg1, makeAssistant("First"), msg2] }),
			{ sessionId: chatId },
		).result();

		assert.equal(calls.length, 3);
		assert.equal(res2.stopReason, "stop");
		assert.equal(res2.model, "claude-sonnet-5-5");
		assert.equal(argValue(calls[1]!.args, "--conversation"), "conv-orig-id");
		assert.equal(argValue(calls[2]!.args, "--conversation"), undefined);
		assert.equal(readLink(chatId), null);
	});
});
