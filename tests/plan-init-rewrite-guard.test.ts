import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	ExtractionRunUsage,
	ImageSnapshot,
	LessonRecordDetails,
	PlanToolResult,
	SideChatThread,
	TurnUsage,
} from "../src/core/contracts.ts";
import type { LhMarkerMessage, LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { planTools } from "../src/agent/tools/plan.ts";

function makeMemoryChatStore(): ChatStore {
	const chats = new Map<string, ChatRecord>();
	return {
		createChat(title, kind) {
			const id = `chat_${chats.size + 1}`;
			const now = "2026-11-20T00:00:00.000Z";
			const rec: ChatRecord = { id, title, createdAt: now, updatedAt: now, messages: [], ...(kind ? { kind } : {}) };
			chats.set(id, rec);
			return rec;
		},
		getChat: (id) => chats.get(id) ?? null,
		listChats: (): ChatSummary[] => [],
		saveMessages: (id, messages) => {
			const rec = chats.get(id);
			if (rec) rec.messages = messages;
		},
		saveImageSnapshot: (_id: string, _sid: string, _img: ImageSnapshot) => {},
		saveTree: (id, tree) => {
			const rec = chats.get(id);
			if (rec) rec.tree = tree;
		},
		appendTurnUsage: (_id: string, _entry: TurnUsage) => {},
		appendExtractionUsage: (_id: string, _entry: ExtractionRunUsage) => {},
		saveSettings: (_id: string, _settings: ChatSettings) => {},
		renameChat: (id) => chats.get(id)!,
		deleteChat: (id) => chats.delete(id),
		updateSideChats: (_id: string, _fn: (t: SideChatThread[]) => SideChatThread[]) => null,
		getCourseMaterial: () => null,
		setCourseMaterial: () => {},
	};
}

function makeQuizCallMsg(id: string, nodeId: string): LhMessage {
	const msg: AssistantMessage & { id: string } = {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `tc_${id}`, name: "quiz", arguments: { nodeId } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	return msg;
}

function makeLessonRecordMarker(id: string, details: LessonRecordDetails): LhMarkerMessage {
	return {
		id,
		role: "custom",
		customType: "lesson-record",
		content: "",
		display: true,
		details,
		timestamp: 1,
	};
}

async function callPlanInit(chatId: string, chatStore: ChatStore, mermaid: string): Promise<PlanToolResult> {
	const tools = planTools({ chatId, chatStore });
	const res = await tools.plan_init!.execute("tc_plan", { mermaid });
	return res.details as PlanToolResult;
}

describe("plan_init rewrite guards: frozen units", () => {
	const initialMermaid = [
		"graph TD",
		"  subgraph basics[Basics]",
		"    a[Node A]",
		"    b[Node B]",
		"  end",
		"  subgraph current[Current Unit]",
		"    c[Node C]",
		"    d[Node D]",
		"  end",
		"  a --> b --> c --> d",
	].join("\n");

	// plan 001 part 2: renaming a finished unit is rejected
	it("rejects renaming a finished unit with exact message", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, initialMermaid);
		const m1 = makeQuizCallMsg("m1", "c");
		chatStore.saveMessages(chat.id, [
			m1,
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "m1",
				finishedUnitIds: ["basics"],
				currentUnitId: "current",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph basics_v2[Basics]",
				"    a[Node A]",
				"    b[Node B]",
				"  end",
				"  subgraph current[Current Unit]",
				"    c[Node C]",
				"    d[Node D]",
				"  end",
				"  a --> b --> c --> d",
			].join("\n"),
		);
		assert.equal(res.ok, false);
		assert.equal(
			res.error,
			'unit "basics" is finished (the lesson has moved past it) — finished units keep their id, order and nodes. Change only the current and later units.',
		);
	});

	// plan 001 part 2: moving a node out of a finished unit is rejected
	it("rejects moving a node out of a finished unit", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, initialMermaid);
		const m1 = makeQuizCallMsg("m1", "c");
		chatStore.saveMessages(chat.id, [
			m1,
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "m1",
				finishedUnitIds: ["basics"],
				currentUnitId: "current",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph basics[Basics]",
				"    a[Node A]",
				"  end",
				"  subgraph current[Current Unit]",
				"    b[Node B]",
				"    c[Node C]",
				"    d[Node D]",
				"  end",
				"  a --> b --> c --> d",
			].join("\n"),
		);
		assert.equal(res.ok, false);
		assert.equal(
			res.error,
			'unit "basics" is finished (the lesson has moved past it) — finished units keep their id, order and nodes. Change only the current and later units.',
		);
	});

	// plan 001 part 2: reordering finished units is rejected
	it("rejects reordering finished units", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph u0[U0]",
				"    a[Node A]",
				"  end",
				"  subgraph u1[U1]",
				"    b[Node B]",
				"  end",
				"  subgraph u2[U2]",
				"    c[Node C]",
				"  end",
			].join("\n"),
		);
		const m1 = makeQuizCallMsg("m1", "c");
		chatStore.saveMessages(chat.id, [
			m1,
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "m1",
				finishedUnitIds: ["u0", "u1"],
				currentUnitId: "u2",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph u1[U1]",
				"    b[Node B]",
				"  end",
				"  subgraph u0[U0]",
				"    a[Node A]",
				"  end",
				"  subgraph u2[U2]",
				"    c[Node C]",
				"  end",
			].join("\n"),
		);
		assert.equal(res.ok, false);
		assert.equal(
			res.error,
			'unit "u0" is finished (the lesson has moved past it) — finished units keep their id, order and nodes. Change only the current and later units.',
		);
	});

	// plan 001 part 2: dropping units when old tree had units and finished.length > 0 -> frozen-units problem
	it("rejects dropping units when finished units exist", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, initialMermaid);
		const m1 = makeQuizCallMsg("m1", "c");
		chatStore.saveMessages(chat.id, [
			m1,
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "m1",
				finishedUnitIds: ["basics"],
				currentUnitId: "current",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			"graph TD\n  a[Node A] --> b[Node B] --> c[Node C] --> d[Node D]",
		);
		assert.equal(res.ok, false);
		assert.equal(
			res.error,
			'unit "basics" is finished (the lesson has moved past it) — finished units keep their id, order and nodes. Change only the current and later units.',
		);
	});

	// plan 001 part 2: keeping finished unit intact and splitting the current unit -> ok
	it("allows splitting the current unit while keeping finished units identical", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, initialMermaid);
		const m1 = makeQuizCallMsg("m1", "c");
		chatStore.saveMessages(chat.id, [
			m1,
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "m1",
				finishedUnitIds: ["basics"],
				currentUnitId: "current",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph basics[Basics]",
				"    a[Node A]",
				"    b[Node B]",
				"  end",
				"  subgraph current[Current Unit]",
				"    c[Node C]",
				"  end",
				"  subgraph later[Later Unit]",
				"    d[Node D]",
				"  end",
				"  a --> b --> c --> d",
			].join("\n"),
		);
		assert.equal(res.ok, true);
	});

	// plan 001 part 2: dangling lesson-record marker does not freeze units
	it("does not freeze units when the only lesson-record marker has a dangling firstKeptMessageId", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, initialMermaid);
		chatStore.saveMessages(chat.id, [
			makeLessonRecordMarker("lr1", {
				firstKeptMessageId: "missing",
				finishedUnitIds: ["basics"],
				currentUnitId: "current",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		]);

		const res = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph basics_v2[Basics]",
				"    a[Node A]",
				"    b[Node B]",
				"  end",
				"  subgraph current[Current Unit]",
				"    c[Node C]",
				"    d[Node D]",
				"  end",
				"  a --> b --> c --> d",
			].join("\n"),
		);
		assert.equal(res.ok, true);
	});
});

describe("plan_init rewrite guards: taught nodes stay at or before current unit", () => {
	// plan 001 part 2: conversion rewrite putting taught nodes in units 0-1 with latest tag in unit 1 -> ok; in unit 2 -> rejected
	it("allows grouping a unitless plan when taught nodes sit at or before the latest tag's unit, and rejects putting one after", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(
			chat.id,
			chatStore,
			"graph TD\n  a[Node A] --> b[Node B] --> c[Node C]",
		);
		chatStore.saveMessages(chat.id, [makeQuizCallMsg("m1", "a"), makeQuizCallMsg("m2", "b")]);

		const badRes = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph u0[Unit 0]",
				"    x[Node X]",
				"  end",
				"  subgraph u1[Unit 1]",
				"    b[Node B]",
				"  end",
				"  subgraph u2[Unit 2]",
				"    a[Node A]",
				"    c[Node C]",
				"  end",
			].join("\n"),
		);
		assert.equal(badRes.ok, false);
		assert.equal(
			badRes.error,
			'node "a" has already been taught but would sit in unit "Unit 2", after the current unit "Unit 1". Keep taught nodes in the current unit or earlier.',
		);

		const okRes = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph u0[Unit 0]",
				"    a[Node A]",
				"  end",
				"  subgraph u1[Unit 1]",
				"    b[Node B]",
				"  end",
				"  subgraph u2[Unit 2]",
				"    c[Node C]",
				"  end",
				"  a --> b --> c",
			].join("\n"),
		);
		assert.equal(okRes.ok, true);
	});

	// plan 001 part 2: if no teach tag's node exists in the new tree, taught-nodes guard passes
	it("passes when no previously taught node exists in the new tree, and when rewriting without units", async () => {
		const chatStore = makeMemoryChatStore();
		const chat = chatStore.createChat("Test");
		await callPlanInit(chat.id, chatStore, "graph TD\n  old[Old] --> old2[Old 2]");
		chatStore.saveMessages(chat.id, [makeQuizCallMsg("m1", "old")]);

		const resWithUnits = await callPlanInit(
			chat.id,
			chatStore,
			[
				"graph TD",
				"  subgraph u0[Unit 0]",
				"    fresh[Fresh]",
				"  end",
			].join("\n"),
		);
		assert.equal(resWithUnits.ok, true);

		const resUnitless = await callPlanInit(
			chat.id,
			chatStore,
			"graph TD\n  fresh[Fresh] --> next[Next]",
		);
		assert.equal(resUnitless.ok, true);
	});
});
