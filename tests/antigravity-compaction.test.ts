/**
 * Antigravity's byte cap drives compaction: agy cuts any request past
 * 192,000 bytes from the END, so LearnHarness compacts once the projected
 * request passes 160,000 bytes — long before the token trigger would
 * (192 KB of German/LaTeX lesson text is only ~71k tokens).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-compaction-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { ensureCompacted, kickCompaction, awaitCompaction, antigravityRequestTrigger, antigravitySummaryFit, antigravityKeptTail } = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const { activeCompactionOf, compactionCutIndex, newCompactionMarker, newUserMessage, toLlmMessages } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
const fauxAssistant = (content: Parameters<typeof fauxAssistantMessage>[0]) => fauxAssistantMessage(content, { stopReason: "toolUse" });
const { AGY_COMPACT_AT_BYTES, AGY_MAX_INPUT_BYTES, AGY_MIN_SUMMARY_BYTES, AGY_TOOL_SCHEMA_RESERVE_BYTES, agyKeepRecentBytes, agyMessageBytes, antigravityRequestBytes, buildAntigravityPrompt, projectedAntigravityRequestBytes } = await import("../src/agent/antigravity/request.ts");
const { toClaudeInput } = await import("../src/agent/claude-code/transcript.ts");
const { ANTIGRAVITY_PROVIDER } = await import("../src/core/contracts/antigravity.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const INSTRUCTIONS = "Teach carefully.";
const llm = (messages: readonly LhMessage[]) => toLlmMessages(messages as readonly AgentMessage[]);

describe("projected Antigravity request bytes", () => {
	it("count the instructions, the replayed conversation in UTF-8 bytes, and the tool-schema reserve", () => {
		const messages = [newUserMessage("Grüße"), newUserMessage("ä".repeat(1_000))];
		const replay = buildAntigravityPrompt({ ...toClaudeInput(llm(messages)), systemPrompt: INSTRUCTIONS, tools: [] }, () => "").prompt;
		const bytes = projectedAntigravityRequestBytes(llm(messages), INSTRUCTIONS);
		assert.ok(bytes >= Buffer.byteLength(replay) + AGY_TOOL_SCHEMA_RESERVE_BYTES);
		assert.ok(bytes < Buffer.byteLength(replay) + AGY_TOOL_SCHEMA_RESERVE_BYTES + 200, "only image path placeholders may differ");
		assert.ok(bytes > 2_000 + AGY_TOOL_SCHEMA_RESERVE_BYTES, "two-byte characters count twice");
	});

	it("honor a compaction cut: dropped history is not counted", () => {
		const old = newUserMessage("x".repeat(100_000));
		const kept = newUserMessage("recent");
		const marker = newCompactionMarker("Summary", { firstKeptMessageId: kept.id, tokensBefore: 1, at: "fixture" });
		assert.ok(projectedAntigravityRequestBytes(llm([old, kept, marker]), INSTRUCTIONS) < 30_000);
	});
});

describe("the Antigravity request trigger", () => {
	/** A conversation whose projected request is exactly `bytes` long. */
	function conversationOf(bytes: number): LhMessage[] {
		const base = projectedAntigravityRequestBytes(llm([newUserMessage("")]), INSTRUCTIONS);
		return [newUserMessage("a".repeat(bytes - base))];
	}

	it("applies only to the Antigravity provider", () => {
		assert.equal(antigravityRequestTrigger("anthropic", INSTRUCTIONS), undefined);
		assert.equal(antigravityRequestTrigger("claude-code", INSTRUCTIONS), undefined);
		assert.equal(typeof antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, INSTRUCTIONS), "function");
	});

	it("fires only above 160,000 projected bytes", () => {
		const over = antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, INSTRUCTIONS)!;
		assert.equal(AGY_COMPACT_AT_BYTES, 160_000);
		assert.equal(over(conversationOf(AGY_COMPACT_AT_BYTES)), false);
		assert.equal(over(conversationOf(AGY_COMPACT_AT_BYTES + 1)), true);
	});

	it("never throws on content the CLI cannot take (the stream reports it instead)", () => {
		const over = antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, INSTRUCTIONS)!;
		const tiff = { ...newUserMessage(""), content: [{ type: "image", mimeType: "image/tiff", data: "AAAA" }] } as LhMessage;
		assert.equal(over([tiff]), false);
	});
});

describe("ensureCompacted with a request-size trigger", () => {
	const chatOf = (label: string) => {
		const chat = chatStore.createChat(label);
		chatStore.saveMessages(chat.id, [newUserMessage(`m1 ${"x".repeat(90_000)}`), newUserMessage(`m2 ${"x".repeat(90_000)}`), newUserMessage("recent")]);
		return chat.id;
	};
	let summaries = 0;
	const depsOf = (requestOverLimit?: CompactionDeps["requestOverLimit"]): CompactionDeps => ({
		chatStore,
		engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: "test", contextWindow: 1_000_000 } } as never,
		modelId: `${ANTIGRAVITY_PROVIDER}:test`,
		kind: "teach",
		thresholdTokens: 10_000_000, // the token trigger never fires here
		systemPromptTokens: 100,
		requestOverLimit,
		summarize: async () => {
			summaries++;
			return { summary: "The learner knows X.", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		},
	});

	it("compacts when the request is over the limit even though tokens are under the threshold", async () => {
		const chatId = chatOf("over bytes");
		const seen: number[] = [];
		await ensureCompacted(depsOf((messages) => { seen.push(messages.length); return true; }), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages), "a marker was written");
		assert.ok(seen.length >= 2, "both the gate and the run's re-check consult the request size");
	});

	it("does nothing when neither tokens nor request size are over", async () => {
		const chatId = chatOf("under both");
		const before = summaries;
		await ensureCompacted(depsOf(() => false), chatId);
		await ensureCompacted(depsOf(undefined), chatId);
		assert.equal(summaries, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	it("re-checks the request size inside the run and skips when it settled beneath", async () => {
		const chatId = chatOf("settled");
		const before = summaries;
		let calls = 0;
		await ensureCompacted(depsOf(() => ++calls === 1), chatId);
		assert.equal(calls, 2);
		assert.equal(summaries, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	it("checks the prospective request, not just saved history", async () => {
		const chatId = chatOf("prospective");
		const cargo = newUserMessage("cargo");
		const lengths: number[] = [];
		await ensureCompacted({ ...depsOf((messages) => { lengths.push(messages.length); return false; }), projectMessages: (record) => [...record.messages, cargo] }, chatId);
		assert.deepEqual(lengths, [4]);
	});
});

describe("the Antigravity summary-request fit", () => {
	const SUMMARIZER = "You are the session-compaction summarizer";
	it("applies only to the Antigravity provider", () => {
		assert.equal(antigravitySummaryFit("anthropic"), undefined);
		assert.equal(typeof antigravitySummaryFit(ANTIGRAVITY_PROVIDER), "function");
	});

	it("measures the real summarizer request: system prompt, no tools, one user message", () => {
		const fits = antigravitySummaryFit(ANTIGRAVITY_PROVIDER)!;
		const sized = (bytes: number) => {
			const probe = (prompt: string) => antigravityRequestBytes([{ role: "user", content: prompt, timestamp: 0 }], fits.systemPrompt);
			const prompt = "a".repeat(bytes - probe(""));
			assert.equal(probe(prompt), bytes);
			return prompt;
		};
		assert.ok(fits.systemPrompt.startsWith(SUMMARIZER));
		assert.equal(fits(sized(AGY_MAX_INPUT_BYTES)), true);
		assert.equal(fits(sized(AGY_MAX_INPUT_BYTES + 1)), false);
	});
});

describe("chunked, chained compaction when the summary request is too large", () => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	/** Six ~30 KB turns plus a recent one: the token trigger fires, and the
	 *  natural span (everything before the ~20k-token kept tail) is ~90 KB. */
	function longChat(label: string) {
		const chat = chatStore.createChat(label);
		const messages = Array.from({ length: 6 }, (_, i) => newUserMessage(`turn ${i} ${"x".repeat(30_000)}`));
		chatStore.saveMessages(chat.id, [...messages, newUserMessage("recent")]);
		return { chatId: chat.id, messages };
	}
	const depsOf = (summaryRequestFits: CompactionDeps["summaryRequestFits"], prompts: string[]): CompactionDeps => ({
		chatStore,
		engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: "test", contextWindow: 1_000_000 } } as never,
		modelId: `${ANTIGRAVITY_PROVIDER}:test`,
		kind: "teach",
		thresholdTokens: 20_000,
		systemPromptTokens: 100,
		summaryRequestFits,
		summarize: async (prompt) => { prompts.push(prompt); return { summary: `SUMMARY ${prompts.length}`, usage }; },
	});

	it("summarizes the oldest chunk that fits first, then chains the rest with the prior summary", async () => {
		const { chatId, messages } = longChat("chunked");
		const unchunked: string[] = [];
		const reference = longChat("reference");
		await ensureCompacted(depsOf(undefined, unchunked), reference.chatId);
		const naturalKept = activeCompactionOf(chatStore.getChat(reference.chatId)!.messages)!.details.firstKeptMessageId;
		const naturalIndex = reference.messages.findIndex((m) => m.id === naturalKept);
		assert.ok(naturalIndex >= 3, "the natural span holds at least three ~30 KB turns");

		const prompts: string[] = [];
		await ensureCompacted(depsOf((prompt) => prompt.length <= 70_000, prompts), chatId);
		assert.ok(prompts.length >= 2, "the span was summarized in more than one request");
		for (const prompt of prompts) assert.ok(prompt.length <= 70_000, "every summary request fits");
		for (let i = 1; i < prompts.length; i++) assert.ok(prompts[i]!.includes(`SUMMARY ${i}`), "each chunk carries the prior summary forward");
		const record = chatStore.getChat(chatId)!.messages;
		const final = activeCompactionOf(record)!;
		assert.equal(final.details.firstKeptMessageId, messages[naturalIndex]!.id, "the chain ends at the cut a single request would have chosen");
		assert.equal(record.filter((m) => m.role === "custom" && m.customType === "compaction").length, prompts.length);
	});

	it("never cuts between a tool call and its result", async () => {
		// The summary request fits only while the tool result is outside the
		// span: a cut right at the result would fit, but would orphan it.
		const chat = chatStore.createChat("tool pairs");
		const call = { ...fauxAssistant([{ type: "toolCall", id: "c1", name: "explain", arguments: { text: "x".repeat(30_000) } }]), id: "call" } as LhMessage;
		const result = { role: "toolResult", toolCallId: "c1", toolName: "explain", content: [{ type: "text", text: "RESULT-MARK" }], isError: false, timestamp: 0, id: "result" } as LhMessage;
		const rest = Array.from({ length: 4 }, (_, i) => newUserMessage(`turn ${i} ${"x".repeat(30_000)}`));
		chatStore.saveMessages(chat.id, [newUserMessage(`start ${"x".repeat(30_000)}`), call, result, ...rest, newUserMessage("recent")]);
		const prompts: string[] = [];
		await ensureCompacted(depsOf((prompt) => !prompt.includes("RESULT-MARK"), prompts), chat.id);
		const kept = chatStore.getChat(chat.id)!.messages.filter((m) => m.role === "custom" && m.customType === "compaction")
			.map((m) => (m as unknown as { details: { firstKeptMessageId: string } }).details.firstKeptMessageId);
		assert.deepEqual(kept, ["call"], "the call starts the kept tail with its result; nothing later fits");
	});

	it("stops without writing anything when not even the smallest chunk fits", async () => {
		const { chatId } = longChat("nothing fits");
		const prompts: string[] = [];
		await ensureCompacted(depsOf(() => false, prompts), chatId);
		assert.equal(prompts.length, 0);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});
});

describe("the Antigravity kept tail", () => {
	/** Real teaching instructions weighed ~40 KB in Nov 2026. */
	const TEACHING = "i".repeat(40_000);
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

	it("applies only to the Antigravity provider", () => {
		assert.equal(antigravityKeptTail("anthropic", TEACHING), undefined);
		assert.equal(typeof antigravityKeptTail(ANTIGRAVITY_PROVIDER, TEACHING), "function");
	});

	it("keeps half of what is left under the trigger after instructions, tool reserve and the expected summary", () => {
		const fixed = antigravityRequestBytes([], TEACHING) + AGY_TOOL_SCHEMA_RESERVE_BYTES;
		assert.equal(AGY_MIN_SUMMARY_BYTES, 16 * 1024);
		assert.equal(agyKeepRecentBytes(TEACHING, 0), Math.floor((AGY_COMPACT_AT_BYTES - fixed - AGY_MIN_SUMMARY_BYTES) / 2), "no prior summary: assume 16 KB");
		assert.equal(agyKeepRecentBytes(TEACHING, 10_000), agyKeepRecentBytes(TEACHING, 0), "a smaller prior summary still assumes 16 KB");
		assert.equal(agyKeepRecentBytes(TEACHING, 30_000), Math.floor((AGY_COMPACT_AT_BYTES - fixed - 30_000) / 2), "a larger prior summary is assumed again");
		assert.equal(agyKeepRecentBytes("i".repeat(200_000), 0), 0, "never negative");
	});

	it("budgets against the chat's prior summary and measures messages in replay bytes", () => {
		const kept = newUserMessage("recent");
		const marker = newCompactionMarker("s".repeat(30_000), { firstKeptMessageId: kept.id, tokensBefore: 1, at: "fixture" });
		const tail = antigravityKeptTail(ANTIGRAVITY_PROVIDER, TEACHING)!([newUserMessage("old"), kept, marker])!;
		assert.equal(tail.budget, agyKeepRecentBytes(TEACHING, Buffer.byteLength(marker.content as string)));
		assert.equal(tail.size, agyMessageBytes);
		assert.ok(agyMessageBytes(newUserMessage("ä".repeat(1_000))) >= 2_000, "two-byte characters count twice");
	});

	it("lets the cut walk with a custom size", () => {
		const messages = Array.from({ length: 6 }, (_, i) => newUserMessage(`m${i}`));
		assert.equal(compactionCutIndex(messages, 12, undefined, () => 4), 3, "three 4-unit messages fill a 12-unit budget");
	});

	it("a long lesson compacts once and leaves room for the next turns", async () => {
		const chat = chatStore.createChat("long lesson");
		chatStore.saveMessages(chat.id, Array.from({ length: 40 }, (_, i) => newUserMessage(`turn ${i} ${"x".repeat(5_000)}`)));
		let summaries = 0;
		const deps: CompactionDeps = {
			chatStore,
			engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: "test", contextWindow: 1_000_000 } } as never,
			modelId: `${ANTIGRAVITY_PROVIDER}:test`,
			kind: "teach",
			thresholdTokens: 10_000_000,
			systemPromptTokens: Math.ceil(TEACHING.length / 4),
			requestOverLimit: antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, TEACHING),
			keptTail: antigravityKeptTail(ANTIGRAVITY_PROVIDER, TEACHING),
			summarize: async () => { summaries++; return { summary: "s".repeat(15_000), usage }; },
		};
		await ensureCompacted(deps, chat.id);
		assert.equal(summaries, 1);
		const bytes = projectedAntigravityRequestBytes(llm(chatStore.getChat(chat.id)!.messages), TEACHING);
		assert.ok(bytes <= AGY_COMPACT_AT_BYTES - 30_000, `the compacted request leaves room for more turns (${bytes} bytes)`);
		for (let i = 0; i < 3; i++) {
			chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, newUserMessage(`next ${i} ${"x".repeat(5_000)}`)]);
			await ensureCompacted(deps, chat.id);
		}
		assert.equal(summaries, 1, "the next turns do not compact again");
	});
});

describe("the settle kick", () => {
	it("starts a compaction when only the request size is over the limit", async () => {
		const chat = chatStore.createChat("kick bytes");
		chatStore.saveMessages(chat.id, [newUserMessage(`m1 ${"x".repeat(90_000)}`), newUserMessage(`m2 ${"x".repeat(90_000)}`), newUserMessage("recent")]);
		let summaries = 0;
		kickCompaction(() => ({
			chatStore,
			engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: "test", contextWindow: 1_000_000 } } as never,
			modelId: `${ANTIGRAVITY_PROVIDER}:test`, kind: "teach", thresholdTokens: 10_000_000, systemPromptTokens: 100,
			requestOverLimit: () => true,
			summarize: async () => { summaries++; return { summary: "S", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; },
		}), chat.id);
		await awaitCompaction(chat.id);
		assert.equal(summaries, 1);
		assert.ok(activeCompactionOf(chatStore.getChat(chat.id)!.messages));
	});
});
