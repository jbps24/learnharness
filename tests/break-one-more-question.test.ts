import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, createProvider, fauxAssistantMessage, type Api, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { newUserMessage, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";

const MIN = 60_000;
const EXPECTED_NOTE_TEXT =
	'[Session note] The learner wants to answer the one remaining question of this node before the break. Pose it now. After their answer, give one line of feedback and suggest the break (requestedBy "window").';

let tmpDir: string;
let POST: typeof import("../app/api/chats/[id]/break/route.ts").POST;
let stores: typeof import("../src/server/index.ts").stores;
let beginTurn: typeof import("../src/server/turn-liveness.ts").beginTurn;
let endTurn: typeof import("../src/server/turn-liveness.ts").endTurn;
let isTurnRunning: typeof import("../src/server/turn-liveness.ts").isTurnRunning;

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-break-one-more-"));
	process.env.LH_DATA_DIR = tmpDir;
	({ POST } = await import("../app/api/chats/[id]/break/route.ts"));
	({ stores } = await import("../src/server/index.ts"));
	({ beginTurn, endTurn, isTurnRunning } = await import("../src/server/turn-liveness.ts"));
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function postBreak(chatId: string, body: unknown): Promise<Response> {
	return POST(
		new Request(`http://test/api/chats/${chatId}/break`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: chatId }) },
	);
}

function pendingMessages(callId: string, oneMoreQuestion?: boolean, now = Date.now()): LhMessage[] {
	return [
		{ ...newUserMessage("hi"), id: "u1", timestamp: now - 5 * MIN },
		{
			id: "a_probe_done",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_pd", name: "probe_done", arguments: {} }],
			stopReason: "toolUse",
			timestamp: now - 4 * MIN,
		} as unknown as LhMessage,
		{
			id: "r_probe_done",
			role: "toolResult",
			toolCallId: "call_pd",
			toolName: "probe_done",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
			isError: false,
			timestamp: now - 4 * MIN + 1,
		} as unknown as LhMessage,
		{
			id: `a_${callId}`,
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "suggest_break",
					arguments: oneMoreQuestion !== undefined ? { requestedBy: "window", oneMoreQuestion } : { requestedBy: "window" },
				},
			],
			stopReason: "toolUse",
			timestamp: now - 1000,
		} as never,
		{
			id: `r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "suggest_break",
			content: [{ type: "text", text: "ok" }],
			details: oneMoreQuestion !== undefined ? { ok: true, requestedBy: "window", oneMoreQuestion } : { ok: true, requestedBy: "window" },
			isError: false,
			timestamp: now - 500,
		} as never,
	];
}

describe("break one-more-question skip", () => {
	// plan 011 part 2: skip of a one-more-question offer appends break-skipped with details.oneMoreQuestion: true and starts one teacher turn carrying the break-note
	it("skipping a one-more-question offer appends break-skipped with flag and runs one teacher turn with the break-note in context", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const baseModel = faux.getModel();
		const providerId = "faux-one-more-q";
		const modelId = "faux-teacher";
		let calls = 0;
		let sawNoteInContext = false;
		const streamFn: StreamFunction<Api, SimpleStreamOptions> = (_model, context, options) => {
			calls++;
			sawNoteInContext = context.messages.some((m) =>
				typeof m.content === "string"
					? m.content.includes(EXPECTED_NOTE_TEXT)
					: Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.includes(EXPECTED_NOTE_TEXT)),
			);
			return faux.streamSimple(baseModel, context, options);
		};
		faux.setResponses([fauxAssistantMessage("Here is your one remaining question.")]);
		piModels().setProvider(
			createProvider({
				id: providerId,
				name: "Faux One More Q",
				auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {}, source: "test" }) } },
				models: [{ ...baseModel, id: modelId, provider: providerId }],
				api: { stream: streamFn, streamSimple: streamFn },
			}),
		);

		try {
			const chat = stores.chatStore.createChat("One more question flow");
			stores.chatStore.saveSettings(chat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveMessages(chat.id, pendingMessages("call_omq", true));

			const res = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_omq" } });
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });

			const deadline = Date.now() + 2000;
			while ((calls === 0 || isTurnRunning(chat.id)) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 10));
			}

			assert.equal(calls, 1);
			assert.equal(sawNoteInContext, true);

			const saved = stores.chatStore.getChat(chat.id)!;
			const skipped = saved.messages.filter((m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-skipped");
			assert.equal(skipped.length, 1);
			assert.deepEqual(skipped[0]!.details, { toolCallId: "call_omq", oneMoreQuestion: true });

			const notes = saved.messages.filter(
				(m): m is LhMarkerMessage =>
					m.role === "custom" && m.customType === "break-note" && (m.details as { kind?: unknown } | null)?.kind === "one-more-question",
			);
			assert.equal(notes.length, 1);
			assert.equal(notes[0]!.display, false);
			assert.equal(notes[0]!.content, EXPECTED_NOTE_TEXT);
		} finally {
			piModels().deleteProvider(providerId);
		}
	});

	// plan 011 part 2: a plain skip stays UI-only and starts no turn
	it("plain skip appends break-skipped without oneMoreQuestion and starts no turn", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const baseModel = faux.getModel();
		const providerId = "faux-plain-skip";
		const modelId = "faux-teacher";
		let calls = 0;
		const streamFn: StreamFunction<Api, SimpleStreamOptions> = (_model, context, options) => {
			calls++;
			return faux.streamSimple(baseModel, context, options);
		};
		piModels().setProvider(
			createProvider({
				id: providerId,
				name: "Faux Plain Skip",
				auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {}, source: "test" }) } },
				models: [{ ...baseModel, id: modelId, provider: providerId }],
				api: { stream: streamFn, streamSimple: streamFn },
			}),
		);

		try {
			const chat = stores.chatStore.createChat("Plain skip");
			stores.chatStore.saveSettings(chat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveMessages(chat.id, pendingMessages("call_plain"));

			const res = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_plain" } });
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			await new Promise((r) => setTimeout(r, 30));

			assert.equal(calls, 0);
			const saved = stores.chatStore.getChat(chat.id)!;
			const skipped = saved.messages.filter((m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-skipped");
			assert.equal(skipped.length, 1);
			assert.deepEqual(skipped[0]!.details, { toolCallId: "call_plain" });
			assert.equal(saved.messages.some((m) => m.role === "custom" && m.customType === "break-note"), false);
		} finally {
			piModels().deleteProvider(providerId);
		}
	});

	// plan 011 part 2: a plain skip stays UI-only, also when the offer's details carry oneMoreQuestion: false
	it("skip of an offer with oneMoreQuestion false is a plain skip and starts no turn", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const baseModel = faux.getModel();
		const providerId = "faux-false-skip";
		const modelId = "faux-teacher";
		let calls = 0;
		const streamFn: StreamFunction<Api, SimpleStreamOptions> = (_model, context, options) => {
			calls++;
			return faux.streamSimple(baseModel, context, options);
		};
		piModels().setProvider(
			createProvider({
				id: providerId,
				name: "Faux False Skip",
				auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {}, source: "test" }) } },
				models: [{ ...baseModel, id: modelId, provider: providerId }],
				api: { stream: streamFn, streamSimple: streamFn },
			}),
		);

		try {
			const chat = stores.chatStore.createChat("False skip");
			stores.chatStore.saveSettings(chat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveMessages(chat.id, pendingMessages("call_false", false));

			const res = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_false" } });
			assert.equal(res.status, 200);
			await new Promise((r) => setTimeout(r, 30));

			assert.equal(calls, 0);
			const saved = stores.chatStore.getChat(chat.id)!;
			const skipped = saved.messages.filter((m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-skipped");
			assert.equal(skipped.length, 1);
			assert.notEqual((skipped[0]!.details as { oneMoreQuestion?: unknown }).oneMoreQuestion, true);
			assert.equal(saved.messages.some((m) => m.role === "custom" && m.customType === "break-note"), false);
		} finally {
			piModels().deleteProvider(providerId);
		}
	});

	// plan 011 part 2: 409 during a running turn
	it("returns 409 on skip of a one-more-question offer during a running turn without appending markers", async () => {
		const chat = stores.chatStore.createChat("Running turn");
		stores.chatStore.saveMessages(chat.id, pendingMessages("call_busy", true));
		assert.equal(beginTurn(chat.id), true);
		try {
			const res = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_busy" } });
			assert.equal(res.status, 409);
			assert.deepEqual(await res.json(), { error: "A turn is running." });

			const saved = stores.chatStore.getChat(chat.id)!;
			assert.equal(saved.messages.some((m) => m.role === "custom" && m.customType === "break-skipped"), false);
			assert.equal(saved.messages.some((m) => m.role === "custom" && m.customType === "break-note"), false);
		} finally {
			endTurn(chat.id);
		}
	});
});

describe("break-skip-one-more validation and settings", () => {
	it("isOneMoreQuestionOffer checks suggest_break tool name when another tool shares the toolCallId", async () => {
		const { isOneMoreQuestionOffer } = await import("../src/core/input-events.ts");
		const baseTime = Date.now() - 5 * MIN;
		const otherToolWithFlag = {
			id: "a_other_flag",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_shared", name: "quiz", arguments: { oneMoreQuestion: true } }],
			stopReason: "toolUse",
			timestamp: baseTime,
		} as unknown as LhMessage;
		const plainSuggestBreak = {
			id: "a_plain_sb",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_shared", name: "suggest_break", arguments: { requestedBy: "window" } }],
			stopReason: "toolUse",
			timestamp: baseTime + 1000,
		} as unknown as LhMessage;
		assert.equal(isOneMoreQuestionOffer([otherToolWithFlag, plainSuggestBreak], "call_shared"), false);

		const otherToolNoFlag = {
			id: "a_other_plain",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_shared_2", name: "quiz", arguments: { question: "Q?" } }],
			stopReason: "toolUse",
			timestamp: baseTime,
		} as unknown as LhMessage;
		const oneMoreSuggestBreak = {
			id: "a_om_sb",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_shared_2", name: "suggest_break", arguments: { requestedBy: "window", oneMoreQuestion: true } }],
			stopReason: "toolUse",
			timestamp: baseTime + 1000,
		} as unknown as LhMessage;
		assert.equal(isOneMoreQuestionOffer([otherToolNoFlag, oneMoreSuggestBreak], "call_shared_2"), true);
	});

	it("parseChatInput rejects break-skip-one-more with an empty toolCallId", async () => {
		const { ChatInputError, parseChatInput } = await import("../src/core/input-events.ts");
		assert.throws(
			() => parseChatInput({ type: "break-skip-one-more", toolCallId: "" }),
			ChatInputError,
		);
		assert.deepEqual(parseChatInput({ type: "break-skip-one-more", toolCallId: "call_valid" }), {
			type: "break-skip-one-more",
			toolCallId: "call_valid",
		});
	});

	it("inputAppends rejects break-skip-one-more when the pending break offer lacks oneMoreQuestion: true", async () => {
		const { ChatInputError, inputAppends } = await import("../src/core/input-events.ts");
		const now = Date.now();
		assert.throws(
			() => inputAppends({ messages: pendingMessages("call_plain_offer", undefined, now) }, { type: "break-skip-one-more", toolCallId: "call_plain_offer" }, now),
			ChatInputError,
		);
		assert.throws(
			() => inputAppends({ messages: pendingMessages("call_false_offer", false, now) }, { type: "break-skip-one-more", toolCallId: "call_false_offer" }, now),
			ChatInputError,
		);
	});

	it("honors effective breaks.resetMinutes and sideChats when skipping a one-more-question offer", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const baseModel = faux.getModel();
		const providerId = "faux-one-more-h1";
		const modelId = "faux-teacher";
		let calls = 0;
		const streamFn: StreamFunction<Api, SimpleStreamOptions> = (_model, context, options) => {
			calls++;
			return faux.streamSimple(baseModel, context, options);
		};
		faux.setResponses([fauxAssistantMessage("Q1."), fauxAssistantMessage("Q2.")]);
		piModels().setProvider(
			createProvider({
				id: providerId,
				name: "Faux One More H1",
				auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {}, source: "test" }) } },
				models: [{ ...baseModel, id: modelId, provider: providerId }],
				api: { stream: streamFn, streamSimple: streamFn },
			}),
		);
		const prevSettings = stores.settingsStore.readSettings();
		try {
			// Custom resetMinutes (30 > default 15) keeps a 20-min-old offer open.
			stores.settingsStore.writeSettings({ version: 1, breaks: { resetMinutes: 30 } });
			const resetChat = stores.chatStore.createChat("Long reset skip");
			stores.chatStore.saveSettings(resetChat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveMessages(resetChat.id, pendingMessages("call_omq_reset", true, Date.now() - 20 * MIN));

			const resetRes = await postBreak(resetChat.id, { input: { type: "skip", toolCallId: "call_omq_reset" } });
			assert.equal(resetRes.status, 200);
			assert.deepEqual(await resetRes.json(), { ok: true });

			const resetDeadline = Date.now() + 2000;
			while ((calls < 1 || isTurnRunning(resetChat.id)) && Date.now() < resetDeadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(calls, 1);

			// Recent side-chat activity keeps a 20-min-old offer open under default resetMinutes (15).
			stores.settingsStore.writeSettings({ version: 1 });
			const sideChat = stores.chatStore.createChat("Side chat active skip");
			stores.chatStore.saveSettings(sideChat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveMessages(sideChat.id, pendingMessages("call_omq_side", true, Date.now() - 20 * MIN));
			const sideAt = new Date(Date.now() - 2 * MIN).toISOString();
			stores.chatStore.updateSideChats(sideChat.id, () => [
				{
					id: "side_1",
					anchor: { messageId: "a_probe_done", partId: "a_probe_done-t0", blockIndex: 0, blockText: "hi" },
					open: true,
					createdAt: sideAt,
					messages: [{ id: "sm_1", role: "user", text: "quick question", at: sideAt }],
				},
			]);

			const sideRes = await postBreak(sideChat.id, { input: { type: "skip", toolCallId: "call_omq_side" } });
			assert.equal(sideRes.status, 200);
			assert.deepEqual(await sideRes.json(), { ok: true });

			const sideDeadline = Date.now() + 2000;
			while ((calls < 2 || isTurnRunning(sideChat.id)) && Date.now() < sideDeadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(calls, 2);
		} finally {
			stores.settingsStore.writeSettings(prevSettings ?? { version: 1 });
			piModels().deleteProvider(providerId);
		}
	});
});
