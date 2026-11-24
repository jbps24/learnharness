import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { inheritCourseMaterial, nodeAtMessage } from "../src/core/course-practice.ts";
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
		createdAt: "2026-11-22T00:00:00.000Z",
		updatedAt: "2026-11-22T00:00:00.000Z",
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
		createdAt: "2026-11-22T00:00:00.000Z",
		provenance,
	};
}

describe("nodeAtMessage", () => {
	// plan 007 part 6: nodeAtMessage returns the nodeId of the latest teach tag at or before the message
	it("returns the latest teach tag at or before the message", () => {
		const tree = makeTree(["n1", "nyquist-zones", "n3"]);
		const tag1 = teachCall("n1");
		const tag2 = teachCall("nyquist-zones");
		const after2 = newUserMessage("explain");
		const tag3 = teachCall("n3");
		const messages = [tag1, tag2, after2, tag3];

		assert.equal(nodeAtMessage(messages, tree, tag2.id), "nyquist-zones");
		assert.equal(nodeAtMessage(messages, tree, after2.id), "nyquist-zones");
		assert.equal(nodeAtMessage(messages, tree, tag3.id), "n3");
	});

	// plan 007 part 6: nodeAtMessage returns null when the message is before any teach tag or not in messages
	it("returns null before any teach tag or when messageId is missing", () => {
		const tree = makeTree(["nyquist-zones"]);
		const before = newUserMessage("hello");
		const tag = teachCall("nyquist-zones");
		const messages = [before, tag];

		assert.equal(nodeAtMessage(messages, tree, before.id), null);
		assert.equal(nodeAtMessage(messages, tree, "missing-id"), null);
		assert.equal(nodeAtMessage(messages, tree, ""), null);
	});

	// plan 007 part 6: nodeAtMessage ignores ids not in the tree
	it("ignores teach tag nodeIds not in the tree", () => {
		const tree = makeTree(["nyquist-zones"]);
		const validTag = teachCall("nyquist-zones");
		const removedTag = teachCall("deleted-node");
		const after = newUserMessage("check");

		assert.equal(nodeAtMessage([validTag, removedTag, after], tree, after.id), "nyquist-zones");
		assert.equal(nodeAtMessage([removedTag, after], tree, after.id), null);
	});
});

describe("inheritCourseMaterial", () => {
	// plan 007 part 6: a pick whose provenance message sits after a teach tag on nyquist-zones inherits that node's method
	it("inherits the node method when provenance sits after a teach tag on nyquist-zones", () => {
		const tree = makeTree(["nyquist-zones"]);
		const tag = teachCall("nyquist-zones");
		const provMsg = newUserMessage("got it");
		const lesson = makeLesson("lesson-1", [tag, provMsg], tree, {
			files: [
				{
					path: "/course/signals.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{
					nodeId: "nyquist-zones",
					path: "/course/signals.pdf",
					pages: "S. 12–15",
					method: "Use folding diagram",
				},
			],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "lesson-1", messageId: provMsg.id }])],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.methods, []);
		assert.deepEqual(inherited.conflicts, []);
		assert.deepEqual(inherited.files, [
			{
				path: "/course/signals.pdf",
				addedAt: "2026-11-22T00:00:00.000Z",
				via: "inherited",
				binding: true,
				status: "assigned",
			},
		]);
		assert.deepEqual(inherited.propositionMethods, [
			{
				propositionId: "p1",
				lessonId: "lesson-1",
				nodeId: "nyquist-zones",
				path: "/course/signals.pdf",
				pages: "S. 12–15",
				method: "Use folding diagram",
			},
		]);
	});

	// plan 007 part 6: a provenance message before any tag inherits nothing
	it("inherits nothing when provenance message is before any teach tag", () => {
		const tree = makeTree(["nyquist-zones"]);
		const before = newUserMessage("intro");
		const tag = teachCall("nyquist-zones");
		const lesson = makeLesson("lesson-1", [before, tag], tree, {
			files: [
				{
					path: "/course/signals.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [{ nodeId: "nyquist-zones", path: "/course/signals.pdf", method: "Use folding diagram" }],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "lesson-1", messageId: before.id }])],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.propositionMethods, []);
		assert.deepEqual(inherited.methods, []);
		assert.deepEqual(inherited.conflicts, []);
	});

	// plan 007 part 6: an unticked file in the lesson is not inherited
	it("does not inherit unticked files or their methods", () => {
		const tree = makeTree(["n1"]);
		const tag = teachCall("n1");
		const provMsg = newUserMessage("ok");
		const lesson = makeLesson("lesson-1", [tag, provMsg], tree, {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/unticked.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "tutor",
					binding: false,
					status: "assigned",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", method: "Method A" },
				{ nodeId: "n1", path: "/course/unticked.pdf", method: "Method Unticked" },
			],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "lesson-1", messageId: provMsg.id }])],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(
			inherited.files.map((f) => f.path),
			["/course/a.pdf"],
		);
		assert.deepEqual(inherited.propositionMethods, [
			{
				propositionId: "p1",
				lessonId: "lesson-1",
				nodeId: "n1",
				path: "/course/a.pdf",
				method: "Method A",
			},
		]);
	});

	// plan 007 part 6: an unresolved conflict contributes nothing, and a chosen one contributes the chosen path
	it("drops unresolved conflicts and keeps only the chosen path for resolved conflicts", () => {
		const tree = makeTree(["n-unresolved", "n-chosen"]);
		const tagUnresolved = teachCall("n-unresolved");
		const msgUnresolved = newUserMessage("q1");
		const tagChosen = teachCall("n-chosen");
		const msgChosen = newUserMessage("q2");

		const lesson = makeLesson("lesson-1", [tagUnresolved, msgUnresolved, tagChosen, msgChosen], tree, {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n-unresolved", path: "/course/a.pdf", method: "Route A1" },
				{ nodeId: "n-unresolved", path: "/course/b.pdf", method: "Route B1" },
				{ nodeId: "n-chosen", path: "/course/a.pdf", method: "Route A2" },
				{ nodeId: "n-chosen", path: "/course/b.pdf", method: "Route B2" },
			],
			conflicts: [
				{ nodeId: "n-unresolved", paths: ["/course/a.pdf", "/course/b.pdf"] },
				{ nodeId: "n-chosen", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/b.pdf" },
			],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p-unresolved", [{ chatId: "lesson-1", messageId: msgUnresolved.id }]),
				makePick("p-chosen", [{ chatId: "lesson-1", messageId: msgChosen.id }]),
			],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.propositionMethods, [
			{
				propositionId: "p-chosen",
				lessonId: "lesson-1",
				nodeId: "n-chosen",
				path: "/course/b.pdf",
				method: "Route B2",
			},
		]);
	});

	// plan 007 part 6: duplicates by (proposition, path, method) are dropped
	it("deduplicates propositionMethods by (proposition, path, method)", () => {
		const tree = makeTree(["n1"]);
		const tag = teachCall("n1");
		const m1 = newUserMessage("first mention");
		const m2 = newUserMessage("second mention");
		const lesson = makeLesson("lesson-1", [tag, m1, m2], tree, {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", method: "Same method" }],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "lesson-1", messageId: m1.id },
					{ chatId: "lesson-1", messageId: m2.id },
				]),
				makePick("p2", [{ chatId: "lesson-1", messageId: m1.id }]),
			],
			new Map([[lesson.id, lesson]]),
		);

		assert.deepEqual(inherited.propositionMethods, [
			{ propositionId: "p1", lessonId: "lesson-1", nodeId: "n1", path: "/course/a.pdf", method: "Same method" },
			{ propositionId: "p2", lessonId: "lesson-1", nodeId: "n1", path: "/course/a.pdf", method: "Same method" },
		]);
		assert.equal(inherited.files.length, 1);
	});

	// plan 007 part 6: duplicates by (proposition, path, method) are dropped across lessons and nodes too
	it("deduplicates the same (proposition, path, method) coming from two lessons or two nodes", () => {
		const tree = makeTree(["n1", "n2"]);
		const file = { path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner" as const, binding: true, status: "assigned" as const };
		const tagA = teachCall("n1");
		const msgA = newUserMessage("a");
		const lessonA = makeLesson("lesson-a", [tagA, msgA], tree, {
			files: [file],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", method: "Same method" }],
			conflicts: [],
		});
		const tagB1 = teachCall("n1");
		const msgB1 = newUserMessage("b1");
		const tagB2 = teachCall("n2");
		const msgB2 = newUserMessage("b2");
		const lessonB = makeLesson("lesson-b", [tagB1, msgB1, tagB2, msgB2], tree, {
			files: [file],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", method: "Same method" },
				{ nodeId: "n2", path: "/course/a.pdf", method: "Same method" },
			],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "lesson-a", messageId: msgA.id },
					{ chatId: "lesson-b", messageId: msgB1.id },
					{ chatId: "lesson-b", messageId: msgB2.id },
				]),
			],
			new Map([
				[lessonA.id, lessonA],
				[lessonB.id, lessonB],
			]),
		);

		assert.equal(inherited.propositionMethods.length, 1);
		assert.equal(inherited.propositionMethods[0]!.propositionId, "p1");
		assert.equal(inherited.propositionMethods[0]!.path, "/course/a.pdf");
		assert.equal(inherited.propositionMethods[0]!.method, "Same method");
	});

	// plan 007 part 6: binding files are added as via "inherited" with status copied; non-teaching/missing lessons ignored; empty picks empty
	it("copies file status as via inherited, ignores non-teaching or missing lessons, and handles empty picks", () => {
		const empty = inheritCourseMaterial([], new Map());
		assert.deepEqual(empty, { files: [], methods: [], conflicts: [], propositionMethods: [] });

		const tree = makeTree(["n1"]);
		const tag = teachCall("n1");
		const msg = newUserMessage("msg");
		const practiceLesson = makeLesson(
			"practice-1",
			[tag, msg],
			tree,
			{
				files: [{ path: "/course/p.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
				methods: [{ nodeId: "n1", path: "/course/p.pdf", method: "Should not inherit" }],
				conflicts: [],
			},
			"practice",
		);
		const teachLesson = makeLesson("teach-1", [tag, msg], tree, {
			files: [{ path: "/course/t.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "tutor", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "missing-lesson", messageId: "m0" },
					{ chatId: "practice-1", messageId: msg.id },
					{ chatId: "teach-1", messageId: msg.id },
				]),
			],
			new Map([
				[practiceLesson.id, practiceLesson],
				[teachLesson.id, teachLesson],
			]),
		);

		assert.deepEqual(inherited.propositionMethods, []);
		assert.deepEqual(inherited.files, [
			{
				path: "/course/t.pdf",
				addedAt: "2026-11-22T00:00:00.000Z",
				via: "inherited",
				binding: true,
				status: "pending",
			},
		]);
	});
});
