import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-resume-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const {
	agyResumableLink,
	fingerprint,
	removeWorkspace,
	writeLink,
} = await import("../src/agent/antigravity/link.ts");
const {
	AGY_COMPACT_AT_BYTES,
	projectedAntigravityRequestBytes,
} = await import("../src/agent/antigravity/request.ts");
const {
	antigravityKeptTail,
	antigravityRequestTrigger,
	antigravitySummaryFit,
	effectiveThresholdTokens,
	ensureCompacted,
} = await import("../src/server/compaction.ts");
import type { AgyResumeCheck, CompactionDeps } from "../src/server/compaction.ts";
const { ANTIGRAVITY_PROVIDER } = await import("../src/core/contracts/antigravity.ts");
const { activeCompactionOf, newUserMessage, toLlmMessages } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";

const createdWorkspaces: string[] = [];
function trackChat(chatId: string): string {
	createdWorkspaces.push(chatId);
	return chatId;
}

afterEach(() => {
	while (createdWorkspaces.length > 0) {
		const id = createdWorkspaces.pop()!;
		try {
			removeWorkspace(id);
		} catch {
			// Best-effort cleanup.
		}
	}
});

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const HYDROGEN_MODEL = "gemini-4-hydrogen";
const HYDROGEN_WINDOW = 128_000;
const INSTRUCTIONS = "Teach carefully.";
const TOOLS: Tool[] = [
	{
		name: "quiz",
		description: "Ask a quiz",
		parameters: {
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		},
	},
];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const SUMMARY_USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: ZERO_COST };

function assistantMsg(id: string, text: string, totalTokens: number, model = HYDROGEN_MODEL): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "antigravity-cli",
		provider: ANTIGRAVITY_PROVIDER,
		model,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: Math.max(0, totalTokens - 100),
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: ZERO_COST,
		},
	} as unknown as LhMessage;
}

function linkForMessages(chatId: string, messages: readonly LhMessage[], model = HYDROGEN_MODEL, systemPrompt = INSTRUCTIONS, tools = TOOLS) {
	const llm = toLlmMessages(messages as readonly AgentMessage[]);
	const sent = llm.length - 1;
	assert.equal(llm[sent]?.role, "assistant", "fixture must end with the assistant reply");
	const link = {
		conversationId: `conv-${chatId}`,
		model,
		messageCount: sent,
		fingerprint: fingerprint(systemPrompt, tools, llm.slice(0, sent)),
	};
	writeLink(chatId, link);
	return link;
}

describe("agyResumableLink", () => {
	// plan 022 part 4: agyResumableLink(chatId, model, systemPrompt, tools, messages) returns the link when resumable
	it("returns the stored link when chatId, model, systemPrompt, tools and message prefix match and conversation[sent] is an assistant reply", () => {
		const chatId = trackChat("resume_link_match");
		const u1 = newUserMessage("Hello");
		const a1 = assistantMsg("a1", "Hi!", 100) as unknown as AssistantMessage;
		const link = {
			conversationId: "conv-1",
			model: HYDROGEN_MODEL,
			messageCount: 1,
			fingerprint: fingerprint(INSTRUCTIONS, TOOLS, [u1]),
		};
		writeLink(chatId, link);

		assert.deepEqual(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, a1]), link);
		const u2 = newUserMessage("Follow-up");
		assert.deepEqual(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, a1, u2]), link);
	});

	// plan 022 part 4: agyResumableLink returns null without a valid chat link
	it("returns null when chatId is undefined or has no stored link", () => {
		const u1 = newUserMessage("Hello");
		const a1 = assistantMsg("a1", "Hi!", 100) as unknown as AssistantMessage;
		assert.equal(agyResumableLink(undefined, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, a1]), null);
		assert.equal(agyResumableLink("missing_chat_link", HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, a1]), null);
	});

	// plan 022 part 4: model change, changed system prompt or tools, or edited message invalidates resume
	it("returns null when model, systemPrompt, tools, or an earlier message in the prefix changed", () => {
		const chatId = trackChat("resume_link_mismatch");
		const u1 = newUserMessage("Hello");
		const a1 = assistantMsg("a1", "Hi!", 100) as unknown as AssistantMessage;
		writeLink(chatId, {
			conversationId: "conv-1",
			model: HYDROGEN_MODEL,
			messageCount: 1,
			fingerprint: fingerprint(INSTRUCTIONS, TOOLS, [u1]),
		});

		assert.equal(agyResumableLink(chatId, "claude-sonnet-5-5", INSTRUCTIONS, TOOLS, [u1, a1]), null);
		assert.equal(agyResumableLink(chatId, HYDROGEN_MODEL, "Different prompt.", TOOLS, [u1, a1]), null);
		assert.equal(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, [], [u1, a1]), null);
		assert.equal(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [newUserMessage("Edited"), a1]), null);
	});

	// plan 022 part 4: retried message invalidates resume
	it("returns null when the reply at messageCount is missing or not an assistant message", () => {
		const chatId = trackChat("resume_link_retried");
		const u1 = newUserMessage("Hello");
		writeLink(chatId, {
			conversationId: "conv-1",
			model: HYDROGEN_MODEL,
			messageCount: 1,
			fingerprint: fingerprint(INSTRUCTIONS, TOOLS, [u1]),
		});

		assert.equal(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1]), null);
		assert.equal(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, newUserMessage("Not assistant")]), null);
	});

	// plan 022 part 4: agyResumableLink matches stream.ts behavior ignoring system messages
	it("ignores system messages in messages when matching the prefix and reply index", () => {
		const chatId = trackChat("resume_link_system");
		const sys: Message = { role: "system", content: "ignored", timestamp: 0 } as unknown as Message;
		const u1 = newUserMessage("Hello");
		const a1 = assistantMsg("a1", "Hi!", 100) as unknown as AssistantMessage;
		const link = {
			conversationId: "conv-1",
			model: HYDROGEN_MODEL,
			messageCount: 1,
			fingerprint: fingerprint(INSTRUCTIONS, TOOLS, [u1]),
		};
		writeLink(chatId, link);

		assert.deepEqual(agyResumableLink(chatId, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [sys, u1, a1]), link);
	});
});

describe("resume-aware compaction trigger", () => {
	function buildDeps(
		chatId: string,
		options: { model?: string; instructions?: string; resume?: AgyResumeCheck; prompts?: string[] } = {},
	): CompactionDeps {
		const model = options.model ?? HYDROGEN_MODEL;
		const instructions = options.instructions ?? INSTRUCTIONS;
		const prompts = options.prompts ?? [];
		return {
			chatStore,
			engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: model, contextWindow: HYDROGEN_WINDOW } } as never,
			modelId: `${ANTIGRAVITY_PROVIDER}:${model}`,
			kind: "teach",
			thresholdTokens: effectiveThresholdTokens(undefined, HYDROGEN_WINDOW),
			systemPromptTokens: Math.ceil(instructions.length / 4),
			requestOverLimit: antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, instructions, options.resume),
			keptTail: antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions, options.resume),
			summaryRequestFits: antigravitySummaryFit(ANTIGRAVITY_PROVIDER),
			summarize: async (prompt) => {
				prompts.push(prompt);
				return { summary: `SUMMARY #${prompts.length}: learner progress.`, usage: SUMMARY_USAGE };
			},
		};
	}

	// plan 022 part 4: while resumable, compact by effectiveThresholdTokens(setting, window) (~112k for Hydrogen), not the 160 KB byte rule
	it("a resumable chat at 170 KB / 45k tokens does not compact", async () => {
		const chat = chatStore.createChat("resumable 170kb 45k");
		const chatId = trackChat(chat.id);
		const messages = [
			newUserMessage("u1 " + "x".repeat(73_000)),
			assistantMsg("a1", "a1 " + "y".repeat(73_000), 45_000),
		];
		chatStore.saveMessages(chatId, messages);
		assert.ok(projectedAntigravityRequestBytes(toLlmMessages(messages as readonly AgentMessage[]), INSTRUCTIONS) > AGY_COMPACT_AT_BYTES);
		linkForMessages(chatId, messages);

		const prompts: string[] = [];
		await ensureCompacted(buildDeps(chatId, { resume: { chatId, model: HYDROGEN_MODEL, tools: TOOLS }, prompts }), chatId);
		assert.equal(prompts.length, 0);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	// plan 022 part 4: Hydrogen 128k - 16k = 111,616 tokens triggers compaction at 115k tokens
	it("a resumable chat at 115k tokens compacts by the model window threshold", async () => {
		const chat = chatStore.createChat("resumable 115k");
		const chatId = trackChat(chat.id);
		const messages = [
			newUserMessage("u1 " + "x".repeat(40_000)),
			assistantMsg("a1", "a1 " + "y".repeat(90_000), 115_000),
		];
		chatStore.saveMessages(chatId, messages);
		linkForMessages(chatId, messages);

		const prompts: string[] = [];
		await ensureCompacted(buildDeps(chatId, { resume: { chatId, model: HYDROGEN_MODEL, tools: TOOLS }, prompts }), chatId);
		assert.equal(prompts.length, 1);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
	});

	// plan 022 part 4: before any turn that needs a full replay (model change, edited/retried message, changed system prompt), the 160 KB byte rule applies
	it("compacts by the byte rule at 170 KB / 45k tokens when model, system prompt, or an earlier message changed, or the last reply was retried", async () => {
		for (const reason of ["model-change", "system-prompt-change", "tools-change", "edited-message", "retried-reply"] as const) {
			const chat = chatStore.createChat(`full-replay-${reason}`);
			const chatId = trackChat(chat.id);
			const u1 = newUserMessage("u1 " + "x".repeat(73_000));
			const a1 = assistantMsg("a1", "a1 " + "y".repeat(73_000), 45_000);
			const saved = reason === "retried-reply" ? [u1, newUserMessage("u2 " + "z".repeat(73_000))] : [u1, a1];
			chatStore.saveMessages(chatId, saved);

			// Link was recorded for the original [u1, a1] under HYDROGEN_MODEL and INSTRUCTIONS.
			linkForMessages(chatId, [u1, a1], HYDROGEN_MODEL, INSTRUCTIONS, TOOLS);
			if (reason === "edited-message") {
				chatStore.saveMessages(chatId, [newUserMessage("edited " + "x".repeat(73_000)), a1]);
			}

			const gateModel = reason === "model-change" ? "claude-sonnet-5-5" : HYDROGEN_MODEL;
			const gateInstructions = reason === "system-prompt-change" ? "Updated instructions." : INSTRUCTIONS;
			const prompts: string[] = [];
			await ensureCompacted(
				buildDeps(chatId, {
					model: gateModel,
					instructions: gateInstructions,
					resume: { chatId, model: gateModel, tools: reason === "tools-change" ? [] : TOOLS },
					prompts,
				}),
				chatId,
			);
			assert.ok(prompts.length >= 1, `${reason}: expected byte-rule compaction`);
			assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages), `${reason}: expected compaction marker`);
		}
	});

	// plan 022 part 4: full replay uses chained summary passes when one summary request does not fit
	it("runs chained summary passes on full replay when one summary request does not fit", async () => {
		const chat = chatStore.createChat("full-replay-chained");
		const chatId = trackChat(chat.id);
		const turns: LhMessage[] = [];
		for (let i = 0; i < 10; i++) {
			turns.push(newUserMessage(`turn-${i} ` + "x".repeat(35_000)));
		}
		const lastReply = assistantMsg("a-last", "reply " + "y".repeat(10_000), 45_000);
		const messages = [...turns, lastReply];
		chatStore.saveMessages(chatId, messages);
		linkForMessages(chatId, messages, HYDROGEN_MODEL, INSTRUCTIONS, TOOLS);

		const prompts: string[] = [];
		// Model change forces full replay; ~350 KB span exceeds one 192 KB summary request.
		await ensureCompacted(
			buildDeps(chatId, {
				model: "claude-sonnet-5-5",
				resume: { chatId, model: "claude-sonnet-5-5", tools: TOOLS },
				prompts,
			}),
			chatId,
		);
		assert.ok(prompts.length >= 2, `expected chained summary passes, got ${prompts.length}`);
		const markers = chatStore.getChat(chatId)!.messages.filter((m) => m.role === "custom" && m.customType === "compaction");
		assert.equal(markers.length, prompts.length);
	});

	// plan 022 part 4: if the gate cannot compute the coming turn's exact tools, it treats the turn as a full replay (byte rule)
	it("treats unknown tools at the gate as a full replay (byte rule)", async () => {
		const chat = chatStore.createChat("unknown-tools");
		const chatId = trackChat(chat.id);
		const messages = [
			newUserMessage("u1 " + "x".repeat(73_000)),
			assistantMsg("a1", "a1 " + "y".repeat(73_000), 45_000),
		];
		chatStore.saveMessages(chatId, messages);
		linkForMessages(chatId, messages);

		const prompts: string[] = [];
		await ensureCompacted(buildDeps(chatId, { resume: { chatId, model: HYDROGEN_MODEL, tools: undefined }, prompts }), chatId);
		assert.equal(prompts.length, 1);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
	});
});

describe("resume-aware trigger edge cases and tail sizing", () => {
	it("returns null without throwing when chatId is unsafe", () => {
		const u1 = newUserMessage("Hello");
		const a1 = assistantMsg("a1", "Hi!", 100) as unknown as AssistantMessage;
		assert.equal(agyResumableLink("../unsafe", HYDROGEN_MODEL, INSTRUCTIONS, TOOLS, [u1, a1]), null);
	});

	it("returns undefined keptTail for a resumable chat and uses the model window token tail at compaction", async () => {
		const instructions = "i".repeat(46 * 1024);
		const chat = chatStore.createChat("resumable token tail");
		const chatId = trackChat(chat.id);
		const u1 = newUserMessage("u1 " + "x".repeat(20_000));
		const a1 = assistantMsg("a1", "a1 " + "y".repeat(22_000), 12_000);
		const u2 = newUserMessage("u2 " + "x".repeat(15_000));
		const a2 = assistantMsg("a2", "a2 " + "y".repeat(15_000), 22_000);
		const u3 = newUserMessage("u3 " + "x".repeat(15_000));
		const a3 = assistantMsg("a3", "a3 " + "y".repeat(15_000), 115_000);
		const messages = [u1, a1, u2, a2, u3, a3];
		chatStore.saveMessages(chatId, messages);
		linkForMessages(chatId, messages, HYDROGEN_MODEL, instructions, TOOLS);

		const resume: AgyResumeCheck = { chatId, model: HYDROGEN_MODEL, tools: TOOLS };
		assert.equal(antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions, resume)!(messages), undefined);

		const prompts: string[] = [];
		await ensureCompacted(
			{
				chatStore,
				engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: HYDROGEN_MODEL, contextWindow: HYDROGEN_WINDOW } } as never,
				modelId: `${ANTIGRAVITY_PROVIDER}:${HYDROGEN_MODEL}`,
				kind: "teach",
				thresholdTokens: effectiveThresholdTokens(undefined, HYDROGEN_WINDOW),
				systemPromptTokens: Math.ceil(instructions.length / 4),
				requestOverLimit: antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, instructions, resume),
				keptTail: antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions, resume),
				summaryRequestFits: antigravitySummaryFit(ANTIGRAVITY_PROVIDER),
				summarize: async (prompt) => {
					prompts.push(prompt);
					return { summary: "SUMMARY: token tail kept.", usage: SUMMARY_USAGE };
				},
			},
			chatId,
		);
		assert.equal(prompts.length, 1);
		const marker = activeCompactionOf(chatStore.getChat(chatId)!.messages);
		assert.ok(marker);
		assert.equal(marker.details.firstKeptMessageId, a1.id);
	});
});
