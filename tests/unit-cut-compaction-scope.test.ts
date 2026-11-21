import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildCompactionPrompt,
	compactionCutIndex,
	compactionCutPoints,
	isContextCut,
	newCompactionMarker,
	type ChatRecord,
	type ChatStore,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/index.ts";
import { ensureCompacted } from "../src/server/compaction.ts";

const userMsg = (id: string, text: string, timestamp = 1): LhMessage => ({
	id,
	role: "user",
	content: text,
	timestamp,
});

const bigUser = (id: string, chars = 4000): LhMessage => userMsg(id, `${id}:${"x".repeat(chars)}`);

const lessonRecordMarker = (
	id: string,
	firstKeptMessageId: string,
	content = "[LESSON RECORD] summary",
	timestamp = 10,
): LhMessage => {
	const details: LessonRecordDetails = {
		firstKeptMessageId,
		finishedUnitIds: ["u1"],
		currentUnitId: "u2",
		judgment: { learnerWide: "", commitments: "", nodes: {} },
		at: "2026-11-20T00:00:00.000Z",
	};
	return {
		id,
		role: "custom",
		customType: "lesson-record",
		content,
		display: true,
		details,
		timestamp,
	};
};

const compactionMarker = (id: string, firstKeptMessageId: string, summary: string, timestamp = 20): LhMessage => ({
	...(newCompactionMarker(summary, {
		firstKeptMessageId,
		tokensBefore: 1000,
		at: "2026-11-20T00:00:00.000Z",
	}) as LhMarkerMessage),
	id,
	timestamp,
});

const planBlockMarker = (id: string): LhMessage => ({
	id,
	role: "custom",
	customType: "plan-block",
	content: "",
	display: true,
	details: {},
	timestamp: 5,
});

const makeStore = (initial: ChatRecord): { store: ChatStore; getRecord: () => ChatRecord } => {
	let record = initial;
	const store = {
		getChat: (id: string) => (id === record.id ? record : null),
		saveMessages: (id: string, messages: LhMessage[]) => {
			if (id === record.id) record = { ...record, messages };
		},
		appendTurnUsage: () => {},
	} as unknown as ChatStore;
	return { store, getRecord: () => record };
};

describe("isContextCut and compaction cut walk with lesson-record markers", () => {
	// plan 001 part 4, files (compaction.ts): isContextCut returns true for compaction and lesson-record, false otherwise
	it("isContextCut identifies compaction and lesson-record markers only", () => {
		assert.equal(isContextCut(compactionMarker("c1", "u1", "sum")), true);
		assert.equal(isContextCut(lessonRecordMarker("r1", "u1")), true);
		assert.equal(isContextCut(planBlockMarker("pb1")), false);
		assert.equal(
			isContextCut({
				id: "un1",
				role: "custom",
				customType: "units-note",
				content: "note",
				display: false,
				details: {},
				timestamp: 1,
			}),
			false,
		);
		assert.equal(userMsg("u1", "hi").role === "user" && isContextCut(userMsg("u1", "hi")), false);
	});

	// plan 001 part 4, rule 3: compactionCutIndex never returns an index <= r when candidates > r exist
	it("compactionCutIndex never returns an index <= r when candidates > r exist", () => {
		const msgs = [
			bigUser("u0"),
			bigUser("u1"), // index 1 = r
			lessonRecordMarker("r1", "u1"), // index 2 (non-candidate)
			bigUser("u2"), // index 3 (first candidate > r)
			bigUser("u3"), // index 4
		];
		const cut = compactionCutIndex(msgs, 1_000_000);
		assert.ok(cut > 1, `expected cut > 1 (r), got ${cut}`);
	});

	// plan 001 part 4, files (compaction.ts): walk-back stops at lesson-record marker
	it("compactionCutIndex does not walk backwards across a lesson-record marker", () => {
		const msgs = [
			bigUser("u0"),
			lessonRecordMarker("r1", "u0"), // index 1
			planBlockMarker("pb1"), // index 2 (non-context metadata)
			bigUser("u2"), // index 3
			bigUser("u3"), // index 4
		];
		const cut = compactionCutIndex(msgs, 1_000_000);
		assert.equal(cut, 2);
	});

	// plan 001 part 4, files (compaction.ts): compactionCutPoints excludes lesson-record and stops walk-back at it
	it("compactionCutPoints excludes lesson-record markers and never walks backwards across them", () => {
		const msgs = [
			userMsg("u0", "a"), // 0
			lessonRecordMarker("r1", "u0"), // 1
			planBlockMarker("pb1"), // 2
			userMsg("u1", "b"), // 3
			userMsg("u2", "c"), // 4
		];
		const points = compactionCutPoints(msgs, 0);
		assert.equal(points.includes(1), false);
		assert.deepEqual(points, [2, 4]);
	});
});

describe("buildCompactionPrompt afterRecord behavior", () => {
	// plan 001 part 4, rule 4: before any record (afterRecord: false) the prompt is unchanged byte-for-byte
	it("with afterRecord: false matches omitting afterRecord byte-for-byte and includes the plan dependency tree", () => {
		const base = {
			spanText: "SPAN_TEXT",
			planTreeText: "- [done] Alpha (a1)\n- Alpha → Beta (a1 → b1)",
			kind: "teach" as const,
		};
		const omitted = buildCompactionPrompt(base);
		const explicitFalse = buildCompactionPrompt({ ...base, afterRecord: false });
		assert.equal(explicitFalse, omitted);
		assert.ok(explicitFalse.includes("## The plan dependency tree"));
		assert.ok(explicitFalse.includes("- [done] Alpha (a1)"));
		assert.equal(explicitFalse.includes("(this unit)"), false);
	});

	// plan 001 part 4, rule 4: afterRecord: true omits plan dependency tree and uses confirmed (this unit) intros
	it("with afterRecord: true omits the plan dependency tree and scopes sections to this unit", () => {
		const prompt = buildCompactionPrompt({
			spanText: "SPAN_TEXT",
			planTreeText: "- [done] Alpha (a1)",
			kind: "teach",
			afterRecord: true,
		});
		assert.equal(prompt.includes("## The plan dependency tree"), false);
		assert.equal(prompt.includes("- [done] Alpha (a1)"), false);
		assert.ok(prompt.includes("## The learner's understanding (this unit)"));
		assert.ok(prompt.includes("## The teaching arc (this unit)"));
		assert.ok(prompt.includes("## The current moment"));
	});

	it("with afterRecord: true omits the probe-phase findings sentence while afterRecord: false keeps it", () => {
		const base = {
			spanText: "SPAN_TEXT",
			planTreeText: "- [done] Alpha (a1)",
			kind: "teach" as const,
		};
		assert.equal(
			buildCompactionPrompt({ ...base, afterRecord: true }).includes("Include probe-phase findings if present."),
			false,
		);
		assert.ok(
			buildCompactionPrompt({ ...base, afterRecord: false }).includes("Include probe-phase findings if present."),
		);
	});
});

describe("compactPass unit-cut scoping", () => {
	const emptyUsage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	// plan 001 part 4, rule 3: if no cut candidate > r exists, compaction does nothing
	it("does nothing when a lesson record exists and no cut candidate > r exists", async () => {
		const { store } = makeStore({
			id: "chat-1",
			title: "Test",
			createdAt: "2026-11-20T00:00:00.000Z",
			updatedAt: "2026-11-20T00:00:00.000Z",
			messages: [bigUser("u0", 8000), lessonRecordMarker("r1", "u0")],
		});
		let called = 0;
		await ensureCompacted(
			{
				chatStore: store,
				engine: {} as never,
				modelId: "test:model",
				kind: "teach",
				thresholdTokens: 10,
				systemPromptTokens: 0,
				summarize: async () => {
					called++;
					return { summary: "SHOULD_NOT_RUN", usage: emptyUsage };
				},
			},
			"chat-1",
		);
		assert.equal(called, 0);
	});

	// plan 001 part 4, rule 3 & rule 4: span starts at r, priorSummary omitted when prevKept < r, prompt uses afterRecord: true
	it("starts span at r, omits priorSummary when previous compaction kept index < r, and drops plan section", async () => {
		const msgs = [
			bigUser("u0", 200),
			compactionMarker("c_old", "u0", "OLD_PRIOR_SUMMARY"),
			bigUser("u1", 200), // r = 2
			lessonRecordMarker("r1", "u1", "RECORD_CONTENT"),
			bigUser("u2", 4000),
			bigUser("u3", 4000),
		];
		const { store } = makeStore({
			id: "chat-2",
			title: "Test",
			createdAt: "2026-11-20T00:00:00.000Z",
			updatedAt: "2026-11-20T00:00:00.000Z",
			tree: { nodes: [{ id: "n1", title: "Node One" }], edges: [], version: 1 },
			messages: msgs,
		});
		const prompts: string[] = [];
		await ensureCompacted(
			{
				chatStore: store,
				engine: {} as never,
				modelId: "test:model",
				kind: "teach",
				thresholdTokens: 10,
				systemPromptTokens: 0,
				keptTail: () => ({ budget: 100 }),
				summarize: async (prompt) => {
					prompts.push(prompt);
					return { summary: "IN_UNIT_SUMMARY", usage: emptyUsage };
				},
			},
			"chat-2",
		);
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0]!.includes("OLD_PRIOR_SUMMARY"), false);
		assert.equal(prompts[0]!.includes("u0:"), false);
		assert.equal(prompts[0]!.includes("## The plan dependency tree"), false);
		assert.equal(prompts[0]!.includes("Node One"), false);
		assert.ok(prompts[0]!.includes("(this unit)"));
	});

	// plan 001 part 4, rule 3 & rule 4: span starts at c and priorSummary is passed when previous compaction kept index >= r
	it("starts span at c and passes priorSummary when previous compaction kept index >= r", async () => {
		const msgs = [
			bigUser("u0", 200), // r = 0
			lessonRecordMarker("r1", "u0", "RECORD_CONTENT"),
			bigUser("u1", 200),
			bigUser("u2", 200), // c = 3 (>= r)
			compactionMarker("c_in_unit", "u2", "IN_UNIT_PRIOR_SUMMARY"),
			bigUser("u3", 4000),
			bigUser("u4", 4000),
		];
		const { store } = makeStore({
			id: "chat-3",
			title: "Test",
			createdAt: "2026-11-20T00:00:00.000Z",
			updatedAt: "2026-11-20T00:00:00.000Z",
			tree: { nodes: [{ id: "n1", title: "Node One" }], edges: [], version: 1 },
			messages: msgs,
		});
		const prompts: string[] = [];
		await ensureCompacted(
			{
				chatStore: store,
				engine: {} as never,
				modelId: "test:model",
				kind: "teach",
				thresholdTokens: 10,
				systemPromptTokens: 0,
				keptTail: () => ({ budget: 100 }),
				summarize: async (prompt) => {
					prompts.push(prompt);
					return { summary: "NEXT_IN_UNIT_SUMMARY", usage: emptyUsage };
				},
			},
			"chat-3",
		);
		assert.equal(prompts.length, 1);
		assert.ok(prompts[0]!.includes("IN_UNIT_PRIOR_SUMMARY"));
		assert.equal(prompts[0]!.includes("u1:"), false);
		assert.equal(prompts[0]!.includes("## The plan dependency tree"), false);
		assert.ok(prompts[0]!.includes("(this unit)"));
	});
});
