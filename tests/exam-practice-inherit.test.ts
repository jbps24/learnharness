import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { inheritCourseMaterial } from "../src/core/course-practice.ts";
import { newMessageId, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

function teachCall(nodeId: string, id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${id}`,
				name: "quiz",
				arguments: { nodeId },
			},
		],
		timestamp: 10,
	} as never;
}

function makeTree(nodeIds: readonly string[]): PlanTree {
	return {
		nodes: nodeIds.map((id) => ({ id, title: id })),
		edges: [],
		version: 1,
	};
}

function makeLesson(
	id: string,
	messages: LhMessage[],
	tree: PlanTree,
	courseMaterial: CourseMaterial,
	kind: ChatRecord["kind"] = "teach",
): ChatRecord {
	return {
		id,
		title: id,
		createdAt: "2026-11-23T00:00:00.000Z",
		updatedAt: "2026-11-23T00:00:00.000Z",
		kind,
		messages,
		tree,
		courseMaterial,
	};
}

function makePick(id: string, provenance: GraphNode["provenance"]): GraphNode {
	return {
		id,
		name: id,
		statement: `Statement for ${id}`,
		aliases: [],
		createdAt: "2026-11-23T00:00:00.000Z",
		provenance,
	};
}

describe("inheritCourseMaterial (exam patterns)", () => {
	// plan 010 part 3: inheritCourseMaterial copies binding exam files and their examPatterns at the pick's node into propositionExamPatterns
	it("inherits exam patterns for binding exam files at the pick's node", () => {
		const tree = makeTree(["nyquist-zones"]);
		const tag = teachCall("nyquist-zones");
		const provMsg = newUserMessage("got it");
		const lesson = makeLesson("lesson-1", [tag, provMsg], tree, {
			files: [
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{
					nodeId: "nyquist-zones",
					path: "/course/ws22.pdf",
					source: "WS22 A3b",
					pages: "S. 4",
					pattern: "Sketch folding diagram for given f_s and f_0",
					grading: "1 pt axis, 2 pts folded frequency",
				},
			],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "lesson-1", messageId: provMsg.id }])],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.files, [
			{
				path: "/course/ws22.pdf",
				addedAt: "2026-11-23T00:00:00.000Z",
				via: "inherited",
				binding: true,
				status: "assigned",
				category: "exam",
				categoryBy: "reader",
			},
		]);
		assert.deepEqual(inherited.propositionExamPatterns, [
			{
				propositionId: "p1",
				lessonId: "lesson-1",
				nodeId: "nyquist-zones",
				path: "/course/ws22.pdf",
				source: "WS22 A3b",
				pages: "S. 4",
				pattern: "Sketch folding diagram for given f_s and f_0",
				grading: "1 pt axis, 2 pts folded frequency",
			},
		]);
	});

	// plan 010 part 3: inheritCourseMaterial copies patterns only at the pick's node
	it("ignores exam patterns at other nodes or when provenance is before any teach tag", () => {
		const tree = makeTree(["n1", "n2"]);
		const before = newUserMessage("intro");
		const tag1 = teachCall("n1");
		const msg1 = newUserMessage("at n1");
		const lesson = makeLesson("lesson-1", [before, tag1, msg1], tree, {
			files: [
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
				},
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pattern: "Pattern 1" },
				{ nodeId: "n2", path: "/course/ws22.pdf", source: "WS22 A2", pattern: "Pattern 2" },
			],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p-before", [{ chatId: "lesson-1", messageId: before.id }]),
				makePick("p-n1", [{ chatId: "lesson-1", messageId: msg1.id }]),
			],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.propositionExamPatterns, [
			{
				propositionId: "p-n1",
				lessonId: "lesson-1",
				nodeId: "n1",
				path: "/course/ws22.pdf",
				source: "WS22 A1",
				pattern: "Pattern 1",
			},
		]);
	});

	// plan 010 part 3: inheritCourseMaterial copies patterns only for binding exam files
	it("does not inherit unticked exam files or patterns from non-binding or non-exam files", () => {
		const tree = makeTree(["n1"]);
		const tag = teachCall("n1");
		const provMsg = newUserMessage("ok");
		const lesson = makeLesson("lesson-1", [tag, provMsg], tree, {
			files: [
				{
					path: "/course/exam-binding.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
				},
				{
					path: "/course/exam-unticked.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
					category: "exam",
				},
				{
					path: "/course/material.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/exam-binding.pdf", source: "WS22 A1", pattern: "Included" },
				{ nodeId: "n1", path: "/course/exam-unticked.pdf", source: "WS21 A1", pattern: "Unticked" },
				{ nodeId: "n1", path: "/course/material.pdf", source: "Notes A1", pattern: "Not exam" },
			],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "lesson-1", messageId: provMsg.id }])],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(
			inherited.files.map((f) => f.path),
			["/course/exam-binding.pdf", "/course/material.pdf"],
		);
		assert.deepEqual(inherited.propositionExamPatterns, [
			{
				propositionId: "p1",
				lessonId: "lesson-1",
				nodeId: "n1",
				path: "/course/exam-binding.pdf",
				source: "WS22 A1",
				pattern: "Included",
			},
		]);
	});

	// plan 010 part 3: propositionExamPatterns are deduplicated by proposition + path + source
	it("deduplicates propositionExamPatterns by (proposition, path, source) while keeping distinct keys", () => {
		const tree = makeTree(["n1", "n2"]);
		const tag1 = teachCall("n1");
		const m1 = newUserMessage("first");
		const m2 = newUserMessage("second");
		const tag2 = teachCall("n2");
		const m3 = newUserMessage("third");
		const fileA = {
			path: "/course/ws22.pdf",
			addedAt: "2026-11-23T00:00:00.000Z",
			via: "learner" as const,
			binding: true,
			status: "assigned" as const,
			category: "exam" as const,
		};
		const fileB = {
			path: "/course/ss23.pdf",
			addedAt: "2026-11-23T00:00:00.000Z",
			via: "learner" as const,
			binding: true,
			status: "assigned" as const,
			category: "exam" as const,
		};
		const lesson = makeLesson("lesson-1", [tag1, m1, m2, tag2, m3], tree, {
			files: [fileA, fileB],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/ws22.pdf", source: "A1", pattern: "Same source on n1" },
				{ nodeId: "n2", path: "/course/ws22.pdf", source: "A1", pattern: "Same source on n2" },
				{ nodeId: "n1", path: "/course/ws22.pdf", source: "A2", pattern: "Different source" },
				{ nodeId: "n1", path: "/course/ss23.pdf", source: "A1", pattern: "Different path" },
			],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "lesson-1", messageId: m1.id },
					{ chatId: "lesson-1", messageId: m2.id },
					{ chatId: "lesson-1", messageId: m3.id },
				]),
				makePick("p2", [{ chatId: "lesson-1", messageId: m1.id }]),
			],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(
			inherited.propositionExamPatterns?.map((p) => `${p.propositionId}|${p.path}|${p.source}`),
			[
				"p1|/course/ws22.pdf|A1",
				"p1|/course/ws22.pdf|A2",
				"p1|/course/ss23.pdf|A1",
				"p2|/course/ws22.pdf|A1",
				"p2|/course/ws22.pdf|A2",
				"p2|/course/ss23.pdf|A1",
			],
		);
	});

	// plan 010 part 3: inheritCourseMaterial ignores non-teaching or missing lessons and defaults empty examPatterns
	it("ignores practice or missing lessons and handles lessons with no examPatterns", () => {
		const tree = makeTree(["n1"]);
		const tag = teachCall("n1");
		const msg = newUserMessage("ok");
		const practiceLesson = makeLesson(
			"practice-1",
			[tag, msg],
			tree,
			{
				files: [{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" }],
				methods: [],
				conflicts: [],
				examPatterns: [{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pattern: "Should not inherit" }],
			},
			"practice",
		);
		const teachLesson = makeLesson("teach-1", [tag, msg], tree, {
			files: [{ path: "/course/notes.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "missing", messageId: "m0" },
					{ chatId: "practice-1", messageId: msg.id },
					{ chatId: "teach-1", messageId: msg.id },
				]),
			],
			new Map([
				[practiceLesson.id, practiceLesson],
				[teachLesson.id, teachLesson],
			]),
		);

		assert.deepEqual(inherited.propositionExamPatterns, []);
	});
});
