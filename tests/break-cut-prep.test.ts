import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { ChatRecord, LessonRecordDetails, LhMarkerMessage, LhMessage } from "../src/core/index.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { atUnitEnd } from "../src/core/units.ts";
import type { CompactionDeps } from "../src/server/compaction.ts";
import { prepareUnitCutDuringBreak } from "../src/server/break-cut-prep.ts";
import { preparedJudgments, runUnitCut, spanKeyOf } from "../src/server/unit-cut.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import { runningUnit } from "../src/server/compaction.ts";

function makeTree(withUnits = true): PlanTree {
	const base: PlanTree = {
		nodes: [
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
			{ id: "n3", title: "Node 3" },
		],
		edges: [
			{ from: "n1", to: "n2" },
			{ from: "n2", to: "n3" },
		],
		version: 1,
	};
	if (!withUnits) return base;
	return {
		...base,
		units: [
			{ id: "u1", title: "Unit 1", nodeIds: ["n1", "n2"] },
			{ id: "u2", title: "Unit 2", nodeIds: ["n3"] },
		],
	};
}

function userMsg(id: string, text = "ok"): LhMessage {
	return {
		id,
		role: "user",
		content: text,
		timestamp: 1,
	} as LhMessage;
}

function teachQuizMsg(id: string, nodeId: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{ type: "text", text: `Checking ${nodeId}` },
			{ type: "toolCall", id: `call-${id}`, name: "quiz", arguments: { nodeId, question: `Q for ${nodeId}?` } },
		],
		timestamp: 2,
	} as unknown as LhMessage;
}

function breakMarker(id: string, customType: "break-note" | "break-taken" | "break-ended"): LhMarkerMessage {
	return {
		id,
		role: "custom",
		customType,
		content: `[${customType}]`,
		display: true,
		details: {},
		timestamp: 3,
	};
}

function createMemoryChatStore(initial: ChatRecord): ChatStore {
	const chats = new Map<string, ChatRecord>([[initial.id, initial]]);
	return {
		createChat: () => {
			throw new Error("not implemented");
		},
		getChat: (id) => chats.get(id) ?? null,
		listChats: () => [],
		saveMessages: (id, messages) => {
			const c = chats.get(id);
			if (c) c.messages = [...messages];
		},
		saveImageSnapshot: () => {},
		saveTree: (id, tree) => {
			const c = chats.get(id);
			if (c) c.tree = tree;
		},
		appendTurnUsage: (id, entry) => {
			const c = chats.get(id);
			if (!c) return;
			c.turns = [...(c.turns ?? []), entry];
		},
		appendExtractionUsage: () => {},
		saveSettings: () => {},
		renameChat: () => {
			throw new Error("not implemented");
		},
		deleteChat: () => false,
		updateSideChats: () => null,
	};
}

const zeroUsage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function judgmentJson(
	nodes: Array<{ nodeId: string; learned: string; errorsCorrected?: string; openPoints?: string }>,
	learnerWide = "steady",
	commitments = "",
): string {
	return JSON.stringify({
		learnerWide,
		commitments,
		nodes: nodes.map((n) => ({
			nodeId: n.nodeId,
			learned: n.learned,
			errorsCorrected: n.errorsCorrected ?? "",
			openPoints: n.openPoints ?? "",
		})),
	});
}

function makeDeps(chatStore: ChatStore, summarize: CompactionDeps["summarize"]): CompactionDeps {
	return {
		chatStore,
		engine: {} as CompactionDeps["engine"],
		modelId: "test:model",
		kind: "teach",
		thresholdTokens: 100_000,
		systemPromptTokens: 100,
		summarize,
	};
}

describe("atUnitEnd", () => {
	// plan 002 part 5: atUnitEnd is true when the tree has units, a next unit exists, and every node of the current unit is visited or current
	it("returns true when the tree has units, a next unit exists, and every node of the current unit is visited or current", () => {
		const tree = makeTree(true);
		const messages = [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2")];
		assert.equal(atUnitEnd(tree, messages), true);
	});

	// plan 002 part 5: atUnitEnd is false mid-unit
	it("returns false mid-unit when an upcoming node remains in the current unit", () => {
		const tree = makeTree(true);
		const messages = [userMsg("m1"), teachQuizMsg("m2", "n1")];
		assert.equal(atUnitEnd(tree, messages), false);
	});

	// plan 002 part 5: atUnitEnd is false in the last unit
	it("returns false in the last unit even when every node is visited or current", () => {
		const tree = makeTree(true);
		const messages = [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2"), teachQuizMsg("m4", "n3")];
		assert.equal(atUnitEnd(tree, messages), false);
	});

	// plan 002 part 5: atUnitEnd is false without units
	it("returns false without units", () => {
		const tree = makeTree(false);
		const messages = [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2"), teachQuizMsg("m4", "n3")];
		assert.equal(atUnitEnd(tree, messages), false);
	});
});

describe("spanKeyOf", () => {
	// plan 002 part 5: spanKeyOf joins previousRecordId and non-marker message ids in [s, k)
	it("includes previousRecordId and non-marker message ids in [s, k), ignoring markers", () => {
		const base = [userMsg("m1"), teachQuizMsg("m2", "n1")];
		const withMarker = [...base, breakMarker("b1", "break-taken")];
		const withExtra = [...base, userMsg("m3")];

		assert.equal(spanKeyOf(base, 0, base.length, undefined), spanKeyOf(withMarker, 0, withMarker.length, undefined));
		assert.notEqual(spanKeyOf(base, 0, base.length, undefined), spanKeyOf(base, 0, base.length, "rec-1"));
		assert.notEqual(spanKeyOf(base, 0, base.length, undefined), spanKeyOf(withExtra, 0, withExtra.length, undefined));
	});
});

describe("prepareUnitCutDuringBreak & runUnitCut", () => {
	beforeEach(() => {
		preparedJudgments.clear();
	});

	// plan 002 part 5: after a prepared span, a cut whose span equals it makes no summarizer call and writes the same judgment into the lesson record
	it("uses prepared judgment without calling summarizer when the cut span matches", async () => {
		const chatId = "chat-match";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2")],
		});

		let calls = 0;
		const deps = makeDeps(store, async () => {
			calls++;
			return {
				summary: judgmentJson(
					[
						{ nodeId: "n1", learned: "understood n1" },
						{ nodeId: "n2", learned: "understood n2" },
					],
					"prefers examples",
				),
				usage: zeroUsage,
			};
		});

		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 1);
		assert.equal(preparedJudgments.has(chatId), true);

		// Move to next unit without adding any extra non-marker messages to [0, k).
		const record = store.getChat(chatId)!;
		store.saveMessages(chatId, [...record.messages, teachQuizMsg("m4", "n3")]);

		calls = 0;
		const res = await runUnitCut(deps, chatId);
		assert.equal(res, "done");
		assert.equal(calls, 0);
		assert.equal(preparedJudgments.has(chatId), false);

		const marker = store.getChat(chatId)!.messages.find(
			(m): m is LhMarkerMessage & { details: LessonRecordDetails } => m.role === "custom" && m.customType === "lesson-record",
		);
		assert.ok(marker);
		assert.deepEqual(marker.details.judgment, {
			learnerWide: "prefers examples",
			commitments: "",
			nodes: {
				n1: { learned: "understood n1", errorsCorrected: "", openPoints: "" },
				n2: { learned: "understood n2", errorsCorrected: "", openPoints: "" },
			},
		});
	});

	// plan 002 part 5: a cut with one extra non-marker message in the span calls the summarizer and discards the entry
	it("calls summarizer and discards the prepared entry when one extra non-marker message is in the span", async () => {
		const chatId = "chat-mismatch";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2")],
		});

		let calls = 0;
		let label = "stale";
		const deps = makeDeps(store, async () => {
			calls++;
			return {
				summary: judgmentJson(
					[
						{ nodeId: "n1", learned: "understood n1" },
						{ nodeId: "n2", learned: "understood n2" },
					],
					label,
				),
				usage: zeroUsage,
			};
		});

		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 1);
		assert.equal(preparedJudgments.has(chatId), true);

		// Add an extra non-marker message before the move to u2.
		label = "fresh";
		const record = store.getChat(chatId)!;
		store.saveMessages(chatId, [...record.messages, userMsg("m-extra", "one more question"), teachQuizMsg("m4", "n3")]);

		calls = 0;
		const res = await runUnitCut(deps, chatId);
		assert.equal(res, "done");
		assert.equal(calls, 1);
		assert.equal(preparedJudgments.has(chatId), false);

		const marker = store.getChat(chatId)!.messages.find(
			(m): m is LhMarkerMessage & { details: LessonRecordDetails } => m.role === "custom" && m.customType === "lesson-record",
		);
		assert.ok(marker);
		assert.equal(marker.details.judgment.learnerWide, "fresh");
	});

	// plan 002 part 5: break markers between the preparation and the move don't break the match
	it("matches the prepared entry even when break markers appear between preparation and move", async () => {
		const chatId = "chat-break-markers";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2")],
		});

		let calls = 0;
		const deps = makeDeps(store, async () => {
			calls++;
			return {
				summary: judgmentJson([
					{ nodeId: "n1", learned: "n1 ok" },
					{ nodeId: "n2", learned: "n2 ok" },
				]),
				usage: zeroUsage,
			};
		});

		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 1);

		const record = store.getChat(chatId)!;
		store.saveMessages(chatId, [
			...record.messages,
			breakMarker("b1", "break-note"),
			breakMarker("b2", "break-taken"),
			breakMarker("b3", "break-ended"),
			teachQuizMsg("m4", "n3"),
		]);

		calls = 0;
		const res = await runUnitCut(deps, chatId);
		assert.equal(res, "done");
		assert.equal(calls, 0);
		assert.equal(preparedJudgments.has(chatId), false);
	});

	// plan 002 part 5: prepareUnitCutDuringBreak only computes when atUnitEnd is true
	it("does nothing and makes no summarizer call when not at unit end", async () => {
		const chatId = "chat-mid-unit";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1")],
		});

		let calls = 0;
		const deps = makeDeps(store, async () => {
			calls++;
			return { summary: judgmentJson([{ nodeId: "n1", learned: "ok" }]), usage: zeroUsage };
		});

		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 0);
		assert.equal(preparedJudgments.has(chatId), false);
	});

	// plan 002 part 5: prepareUnitCutDuringBreak failures only log
	it("logs and does not throw or store an entry when judgment computation fails", async () => {
		const chatId = "chat-fail";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2")],
		});

		const deps = makeDeps(store, async () => {
			throw new Error("provider unavailable");
		});

		await assert.doesNotReject(() => prepareUnitCutDuringBreak(deps, chatId));
		assert.equal(preparedJudgments.has(chatId), false);
	});
});

describe("runUnitCut", () => {
	beforeEach(() => {
		preparedJudgments.clear();
	});

	// plan 002 part 5: runUnitCut without a registry entry behaves exactly as before (same marker fields for the same stubbed judgment)
	it("without a registry entry writes the expected lesson-record marker fields for a stubbed judgment", async () => {
		const chatId = "chat-baseline";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2"), teachQuizMsg("m4", "n3")],
		});

		let calls = 0;
		const deps = makeDeps(store, async () => {
			calls++;
			return {
				summary: judgmentJson(
					[
						{ nodeId: "n1", learned: "solid n1", errorsCorrected: "fixed sign", openPoints: "" },
						{ nodeId: "n2", learned: "solid n2", errorsCorrected: "", openPoints: "edge case" },
					],
					"likes concise steps",
					"revisit n2 edge case",
				),
				usage: zeroUsage,
			};
		});

		const res = await runUnitCut(deps, chatId);
		assert.equal(res, "done");
		assert.equal(calls, 1);

		const marker = store.getChat(chatId)!.messages.find(
			(m): m is LhMarkerMessage & { details: LessonRecordDetails } => m.role === "custom" && m.customType === "lesson-record",
		);
		assert.ok(marker);
		assert.equal(marker.display, true);
		assert.equal(typeof marker.content, "string");
		assert.ok(marker.content.length > 0);
		assert.equal(marker.details.firstKeptMessageId, "m4");
		assert.deepEqual(marker.details.finishedUnitIds, ["u1"]);
		assert.equal(marker.details.currentUnitId, "u2");
		assert.equal(marker.details.model, "test:model");
		assert.equal(typeof marker.details.tokensBefore, "number");
		assert.ok(marker.details.tokensBefore !== undefined);
		assert.ok(marker.details.tokensBefore > 0);
		assert.equal(typeof marker.details.at, "string");
		assert.ok(marker.details.at.length > 0);
		assert.deepEqual(marker.details.judgment, {
			learnerWide: "likes concise steps",
			commitments: "revisit n2 edge case",
			nodes: {
				n1: { learned: "solid n1", errorsCorrected: "fixed sign", openPoints: "" },
				n2: { learned: "solid n2", errorsCorrected: "", openPoints: "edge case" },
			},
		});
	});

	it("returns failed before setting the running flag or emitting compaction-changed when the prompt does not fit", async () => {
		const chatId = "chat-no-fit";
		const tree = makeTree(true);
		const store = createMemoryChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1"), teachQuizMsg("m2", "n1"), teachQuizMsg("m3", "n2"), teachQuizMsg("m4", "n3")],
		});

		let calls = 0;
		const deps: CompactionDeps = {
			...makeDeps(store, async () => {
				calls++;
				return { summary: "{}", usage: zeroUsage };
			}),
			// no summary request fits: the unit cut fails before any summary starts
			thresholdTokens: 1,
		};

		const events: ServerEvent<"compaction-changed">[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "compaction-changed" && event.chatId === chatId) events.push(event);
		});
		try {
			const res = await runUnitCut(deps, chatId);
			assert.equal(res, "failed");
		} finally {
			unsubscribe();
		}

		assert.equal(calls, 0);
		assert.equal(runningUnit(chatId), undefined);
		assert.deepEqual(events, []);
	});
});
