import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	LESSON_RECORD_HEADER,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
	type PlanTree,
} from "../src/core/index.ts";
import { projectView } from "../src/core/view.ts";

const userMsg = (id: string, text: string): LhMessage => ({
	id,
	role: "user",
	content: text,
	timestamp: 1,
});

const planInitMessages = (tree: PlanTree): LhMessage[] => [
	{
		id: "a_plan",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_plan", name: "plan_init", arguments: { mermaid: "graph TD" } }],
		timestamp: 1,
	} as never,
	{
		id: "r_plan",
		role: "toolResult",
		toolCallId: "call_plan",
		toolName: "plan_init",
		content: [{ type: "text", text: "ok" }],
		details: { ok: true, tree },
		isError: false,
		timestamp: 2,
	} as never,
];

const lessonRecordMarker = (id: string, details: LessonRecordDetails): LhMarkerMessage => ({
	id,
	role: "custom",
	customType: "lesson-record",
	content: `${LESSON_RECORD_HEADER}\n\nSummary`,
	display: false,
	details,
	timestamp: 10,
});

const TREE: PlanTree = {
	nodes: [
		{ id: "n1", title: "Basics" },
		{ id: "n2", title: "Derivatives" },
		{ id: "n3", title: "Integrals" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
	],
	units: [
		{ id: "u1", title: "Foundations", nodeIds: ["n1"] },
		{ id: "u2", title: "Derivatives", nodeIds: ["n2"] },
		{ id: "u3", title: "Integrals", nodeIds: ["n3"] },
	],
	version: 1,
};

describe("projectView unit cuts", () => {
	// plan 001 part 8: emit data-unit-cut before each lesson-record marker's firstKeptMessageId with 1-based unitIndex and unit title
	it("emits data-unit-cut before the lesson-record's firstKeptMessageId with 1-based unitIndex and title", () => {
		const messages: LhMessage[] = [
			...planInitMessages(TREE),
			userMsg("m1", "unit 1"),
			userMsg("m2", "unit 2 start"),
			lessonRecordMarker("lr1", {
				firstKeptMessageId: "m2",
				finishedUnitIds: ["u1"],
				currentUnitId: "u2",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		];
		const view = projectView(messages);
		const m2Index = view.findIndex((m) => m.id === "m2");
		assert.ok(m2Index > 0, "kept message m2 is in the view");
		assert.deepEqual(view[m2Index - 1], {
			id: "unit_lr1",
			role: "user",
			parts: [
				{
					type: "data-unit-cut",
					id: "uc_lr1",
					data: { unitIndex: 2, title: "Derivatives" },
				},
			],
		});
	});

	// plan 001 part 8: emit data-unit-cut for every record, not only the newest
	it("emits a divider for every lesson-record marker, not only the newest", () => {
		const messages: LhMessage[] = [
			...planInitMessages(TREE),
			userMsg("m1", "unit 1"),
			userMsg("m2", "unit 2 start"),
			lessonRecordMarker("lr1", {
				firstKeptMessageId: "m2",
				finishedUnitIds: ["u1"],
				currentUnitId: "u2",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
			userMsg("m3", "unit 3 start"),
			lessonRecordMarker("lr2", {
				firstKeptMessageId: "m3",
				finishedUnitIds: ["u1", "u2"],
				currentUnitId: "u3",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:01:00.000Z",
			}),
		];
		const view = projectView(messages);
		const cuts = view.filter((m) => m.parts.some((p) => p.type === "data-unit-cut"));
		assert.equal(cuts.length, 2);
		assert.deepEqual(cuts[0], {
			id: "unit_lr1",
			role: "user",
			parts: [{ type: "data-unit-cut", id: "uc_lr1", data: { unitIndex: 2, title: "Derivatives" } }],
		});
		assert.deepEqual(cuts[1], {
			id: "unit_lr2",
			role: "user",
			parts: [{ type: "data-unit-cut", id: "uc_lr2", data: { unitIndex: 3, title: "Integrals" } }],
		});
		const m2Index = view.findIndex((m) => m.id === "m2");
		const m3Index = view.findIndex((m) => m.id === "m3");
		assert.equal(view[m2Index - 1]?.id, "unit_lr1");
		assert.equal(view[m3Index - 1]?.id, "unit_lr2");
	});

	// plan 001 part 8: lesson-record renders nothing (no moment note)
	it("renders nothing at the lesson-record marker itself", () => {
		const messages: LhMessage[] = [
			...planInitMessages(TREE),
			userMsg("m1", "unit 1"),
			userMsg("m2", "unit 2 start"),
			lessonRecordMarker("lr1", {
				firstKeptMessageId: "m2",
				finishedUnitIds: ["u1"],
				currentUnitId: "u2",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		];
		const view = projectView(messages);
		assert.equal(view.some((m) => m.id === "lr1"), false);
		assert.equal(
			view.some((m) => m.parts.some((p) => p.type === "data-lesson-record" || p.type === "data-compaction")),
			false,
		);
	});

	// plan 001 part 8: fallback unitIndex = finishedUnitIds.length + 1 and title = currentUnitId when unit id is gone
	it("falls back to finishedUnitIds.length + 1 and currentUnitId when the unit id is gone from the tree", () => {
		const messages: LhMessage[] = [
			...planInitMessages(TREE),
			userMsg("m1", "unit 1"),
			userMsg("m2", "kept"),
			lessonRecordMarker("lr_gone", {
				firstKeptMessageId: "m2",
				finishedUnitIds: ["u1", "u2"],
				currentUnitId: "removed-unit",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-20T00:00:00.000Z",
			}),
		];
		const view = projectView(messages);
		const m2Index = view.findIndex((m) => m.id === "m2");
		assert.deepEqual(view[m2Index - 1], {
			id: "unit_lr_gone",
			role: "user",
			parts: [
				{
					type: "data-unit-cut",
					id: "uc_lr_gone",
					data: { unitIndex: 3, title: "removed-unit" },
				},
			],
		});
	});
});
