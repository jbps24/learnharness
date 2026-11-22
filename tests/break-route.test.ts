import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { breakState, breakTimings } from "../src/core/breaks.ts";
import { subscribe } from "../src/core/events.ts";
import { newUserMessage, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";
import { createFauxCore, createProvider, fauxAssistantMessage, type Api, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import type { PlanTree } from "../src/core/contracts/plan.ts";

const MIN = 60_000;
const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10 });

let tmpDir: string;
let POST: typeof import("../app/api/chats/[id]/break/route.ts").POST;
let stores: typeof import("../src/server/index.ts").stores;
let beginTurn: typeof import("../src/server/turn-liveness.ts").beginTurn;
let endTurn: typeof import("../src/server/turn-liveness.ts").endTurn;

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-break-route-"));
	process.env.LH_DATA_DIR = tmpDir;
	({ POST } = await import("../app/api/chats/[id]/break/route.ts"));
	({ stores } = await import("../src/server/index.ts"));
	({ beginTurn, endTurn } = await import("../src/server/turn-liveness.ts"));
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function pendingOfferMessages(callId: string, now = Date.now()): LhMessage[] {
	return [
		{ ...newUserMessage("hi"), id: "u1", timestamp: now - 5 * MIN },
		{
			id: `a_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: { requestedBy: "window" } }],
			stopReason: "toolUse",
			timestamp: now - 1000,
		} as never,
		{
			id: `r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "suggest_break",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
			isError: false,
			timestamp: now - 500,
		} as never,
	];
}

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

describe("POST /api/chats/[id]/break", () => {
	// plan 002 part 4: 404 for an unknown chat
	it("returns 404 for an unknown chat", async () => {
		const res = await postBreak("chat_does_not_exist", { input: { type: "take", toolCallId: "call_1" } });
		assert.equal(res.status, 404);
	});

	// plan 002 part 4: invalid input body returns 400
	it("returns 400 for an invalid input payload", async () => {
		const chat = stores.chatStore.createChat("Bad body");
		const res = await postBreak(chat.id, { input: { type: "bogus", toolCallId: "call_1" } });
		assert.equal(res.status, 400);
	});

	// plan 002 part 4: Take during a running turn -> 409 { error: "A turn is running." }
	it("returns 409 while a turn is running", async () => {
		const chat = stores.chatStore.createChat("Running turn");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_run"));
		assert.equal(beginTurn(chat.id), true);
		try {
			const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_run" } });
			assert.equal(res.status, 409);
			assert.deepEqual(await res.json(), { error: "A turn is running." });
		} finally {
			endTurn(chat.id);
		}
	});

	// plan 002 part 4: Take with the wrong id -> 400 { error: "No break offer is open." }
	it("returns 400 when toolCallId does not match the pending offer", async () => {
		const chat = stores.chatStore.createChat("Wrong id");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_real"));

		const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_wrong" } });
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "No break offer is open." });
	});

	// plan 002 part 4: 400 { error: "No break offer is open." } when no offer exists
	it("returns 400 when no break offer is pending", async () => {
		const chat = stores.chatStore.createChat("No offer");
		stores.chatStore.saveMessages(chat.id, [{ ...newUserMessage("hi"), id: "u1", timestamp: Date.now() }]);

		const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_none" } });
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "No break offer is open." });
	});

	// plan 002 part 4: Take appends break-taken, emits record-changed, returns { ok: true }
	it("appends break-taken with effective lengthMinutes and emits record-changed", async () => {
		stores.settingsStore.writeSettings({ version: 1, breaks: { lengthMinutes: 12 } });
		const chat = stores.chatStore.createChat("Take ok");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_take"));

		const events: string[] = [];
		const off = subscribe((e) => {
			if (e.type === "record-changed") events.push(e.chatId);
		});
		try {
			const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_take" } });
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.deepEqual(events, [chat.id]);

			const saved = stores.chatStore.getChat(chat.id)!;
			const taken = saved.messages.filter((m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-taken");
			assert.equal(taken.length, 1);
			assert.deepEqual(taken[0]!.details, { toolCallId: "call_take", lengthMinutes: 12 });
		} finally {
			off();
		}
	});

	// an open plugin question blocks Take/Skip: Continue would be refused, trapping the learner on the break screen
	it("returns 400 and appends nothing while a plugin question is open", async () => {
		const chat = stores.chatStore.createChat("Plugin question open");
		const now = Date.now();
		const questionMessage = {
			id: "a_pq",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_pq", name: "plugin_question", arguments: {} }],
			lhQuestions: "unreadable",
			stopReason: "toolUse",
			timestamp: now - 2000,
		} as unknown as LhMessage;
		const messages = [questionMessage, ...pendingOfferMessages("call_pq_break", now)];
		stores.chatStore.saveMessages(chat.id, messages);

		const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_pq_break" } });
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "Answer or dismiss the pending plugin question first" });

		const saved = stores.chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.filter((m) => m.role === "custom" && m.customType === "break-taken").length, 0);
	});

	// plan 002 part 4: Take then Skip -> 400 (no longer pending)
	it("returns 400 on Skip after Take", async () => {
		const chat = stores.chatStore.createChat("Take then Skip");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_ts"));

		const takeRes = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_ts" } });
		assert.equal(takeRes.status, 200);

		const skipRes = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_ts" } });
		assert.equal(skipRes.status, 400);
		assert.deepEqual(await skipRes.json(), { error: "No break offer is open." });
	});

	// plan 002 part 4: Take twice -> the second gets 400 and the transcript holds one break-taken
	it("returns 400 on second Take and keeps a single break-taken marker", async () => {
		const chat = stores.chatStore.createChat("Take twice");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_twice"));

		const first = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_twice" } });
		assert.equal(first.status, 200);

		const second = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_twice" } });
		assert.equal(second.status, 400);
		assert.deepEqual(await second.json(), { error: "No break offer is open." });

		const saved = stores.chatStore.getChat(chat.id)!;
		const taken = saved.messages.filter((m) => m.role === "custom" && m.customType === "break-taken");
		assert.equal(taken.length, 1);
	});

	// plan 002 part 4: Skip appends break-skipped, emits record-changed, returns { ok: true }
	it("appends break-skipped and emits record-changed on Skip", async () => {
		const chat = stores.chatStore.createChat("Skip ok");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_skip"));

		const events: string[] = [];
		const off = subscribe((e) => {
			if (e.type === "record-changed") events.push(e.chatId);
		});
		try {
			const res = await postBreak(chat.id, { input: { type: "skip", toolCallId: "call_skip" } });
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.deepEqual(events, [chat.id]);

			const saved = stores.chatStore.getChat(chat.id)!;
			const state = breakState(saved.messages, saved.sideChats, TIMINGS, true, Date.now());
			assert.equal(state.latest?.outcome, "skipped");
		} finally {
			off();
		}
	});

	// plan 002 part 4: changing lengthMinutes in settings after Take leaves the marker's saved lengthMinutes
	it("preserves the saved lengthMinutes on break-taken after settings change", async () => {
		stores.settingsStore.writeSettings({ version: 1, breaks: { lengthMinutes: 8 } });
		const chat = stores.chatStore.createChat("Length preserved");
		stores.chatStore.saveMessages(chat.id, pendingOfferMessages("call_len"));

		const res = await postBreak(chat.id, { input: { type: "take", toolCallId: "call_len" } });
		assert.equal(res.status, 200);

		stores.settingsStore.writeSettings({ version: 1, breaks: { lengthMinutes: 20 } });
		const saved = stores.chatStore.getChat(chat.id)!;
		const state = breakState(saved.messages, saved.sideChats, TIMINGS, true, Date.now());
		assert.equal(state.latest?.outcome, "taken");
		assert.equal(state.latest?.lengthMinutes, 8);
	});

	// plan 002 part 4/5: Take at a unit end calls prepareUnitCutDuringBreak without awaiting it, and Skip does not
	it("calls prepareUnitCutDuringBreak on Take at a unit end and not on Skip", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const { preparedJudgments } = await import("../src/server/unit-cut.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const baseModel = faux.getModel();
		const providerId = "faux-break-route";
		const modelId = "faux-cut-model";
		let calls = 0;
		const streamFn: StreamFunction<Api, SimpleStreamOptions> = (_model, context, options) => {
			calls++;
			return faux.streamSimple(baseModel, context, options);
		};
		faux.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					learnerWide: "steady",
					commitments: "",
					nodes: [{ nodeId: "n1", learned: "solid", errorsCorrected: "", openPoints: "" }],
				}),
			),
		]);
		piModels().setProvider(
			createProvider({
				id: providerId,
				name: "Faux Break Route",
				auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {}, source: "test" }) } },
				models: [{ ...baseModel, id: modelId, provider: providerId }],
				api: { stream: streamFn, streamSimple: streamFn },
			}),
		);
		preparedJudgments.clear();

		const tree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Node 1" },
				{ id: "n2", title: "Node 2" },
			],
			edges: [{ from: "n1", to: "n2" }],
			units: [
				{ id: "u1", title: "Unit 1", nodeIds: ["n1"] },
				{ id: "u2", title: "Unit 2", nodeIds: ["n2"] },
			],
			version: 1,
		};
		const unitEndMessages = (callId: string): LhMessage[] => {
			const now = Date.now();
			return [
				{
					id: `q_${callId}`,
					role: "assistant",
					content: [
						{ type: "text", text: "Checking n1" },
						{ type: "toolCall", id: `quiz_${callId}`, name: "quiz", arguments: { nodeId: "n1", question: "Q?" } },
					],
					timestamp: now - 7 * MIN,
				} as unknown as LhMessage,
				{
					id: `qr_${callId}`,
					role: "toolResult",
					toolCallId: `quiz_${callId}`,
					toolName: "quiz",
					content: [{ type: "text", text: "ok" }],
					details: { ok: true },
					isError: false,
					timestamp: now - 6 * MIN,
				} as never,
				...pendingOfferMessages(callId, now),
			];
		};

		try {
			const skipChat = stores.chatStore.createChat("Skip unit end");
			stores.chatStore.saveSettings(skipChat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveTree(skipChat.id, tree);
			stores.chatStore.saveMessages(skipChat.id, unitEndMessages("call_skip_prep"));

			const skipRes = await postBreak(skipChat.id, { input: { type: "skip", toolCallId: "call_skip_prep" } });
			assert.equal(skipRes.status, 200);
			await new Promise((r) => setTimeout(r, 25));
			assert.equal(calls, 0);
			assert.equal(preparedJudgments.has(skipChat.id), false);

			const takeChat = stores.chatStore.createChat("Take unit end");
			stores.chatStore.saveSettings(takeChat.id, { model: { provider: providerId, id: modelId } });
			stores.chatStore.saveTree(takeChat.id, tree);
			stores.chatStore.saveMessages(takeChat.id, unitEndMessages("call_take_prep"));

			const takeRes = await postBreak(takeChat.id, { input: { type: "take", toolCallId: "call_take_prep" } });
			assert.equal(takeRes.status, 200);

			const deadline = Date.now() + 2000;
			while (!preparedJudgments.has(takeChat.id) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(calls, 1);
			assert.equal(preparedJudgments.get(takeChat.id)?.judgment.nodes.n1?.learned, "solid");
		} finally {
			preparedJudgments.clear();
			piModels().deleteProvider(providerId);
		}
	});
});
