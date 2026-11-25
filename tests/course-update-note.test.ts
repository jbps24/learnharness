import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor, practiceCourseNotesFor } from "../src/core/course-notes.ts";
import { failedResponseAtEnd, retryableReply } from "../src/core/input-events.ts";
import {
	nativeInputCause,
	newMessageId,
	newUserMessage,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { spanKeyOf } from "../src/server/unit-cut.ts";

const BEFORE_REPLACE_MS = Date.parse("2026-11-24T10:00:00.000Z");
const REPLACE_AT = "2026-11-24T12:00:00.000Z";
const AFTER_REPLACE_MS = Date.parse("2026-11-24T14:00:00.000Z");

function quizCall(nodeId: string, timestamp = BEFORE_REPLACE_MS, id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${nodeId}_${timestamp}`,
				name: "quiz",
				arguments: { nodeId },
			},
		],
		timestamp,
	} as never;
}

function assistantStop(text: string, id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 10,
	} as never;
}

function failedAssistant(id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
		timestamp: 10,
	} as never;
}

function courseUpdateMarker(content = "update note", details: unknown = { digest: "d1" }): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "course-update",
		content,
		display: false,
		details,
		timestamp: 20,
	};
}

function makeTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
			{ id: "n3", title: "Node 3" },
		],
		edges: [
			{ from: "n1", to: "n2" },
			{ from: "n2", to: "n3" },
		],
		units: [
			{ id: "u1", title: "Unit 1", nodeIds: ["n1", "n2"] },
			{ id: "u2", title: "Unit 2", nodeIds: ["n3"] },
		],
		version: 1,
	};
}

describe("course-update marker and skip lists", () => {
	// plan 015 part 3: customType course-update, neutral, display:false, projects to user wire text
	it("constructs course-update markers as neutral non-displayed user-wire notes", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 1–2", method: "Old route" }],
						nodes: [{ nodeId: "n1", kind: "changed" }],
						revisited: [],
						planAsked: true,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 3–4", method: "New route" }],
			conflicts: [],
		};

		const notes = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], tree, material);
		const updateNote = notes.find((n) => n.customType === "course-update");
		assert.ok(updateNote, "expected a course-update note");
		assert.equal(updateNote.display, false);
		assert.equal(nativeInputCause(updateNote, []), "neutral");
		assert.deepEqual(toLlmMessages([updateNote]), [
			{ role: "user", content: [{ type: "text", text: updateNote.content }], timestamp: updateNote.timestamp },
		]);
	});

	// plan 015 part 3: course-update uses the same skip lists as course-method
	it("skips course-update markers in failedResponseAtEnd, retryableReply, and spanKeyOf", () => {
		const user = newUserMessage("hi");
		const err = failedAssistant();
		const reply = assistantStop("ok");
		const updateMsg = courseUpdateMarker();

		assert.equal(failedResponseAtEnd([user, err, updateMsg])?.id, err.id);
		assert.deepEqual(retryableReply([user, updateMsg, reply]), [reply.id]);

		const tail = newUserMessage("next");
		assert.equal(
			spanKeyOf([user, err, tail], 0, 3, "rec_1"),
			spanKeyOf([user, updateMsg, err, tail], 0, 4, "rec_1"),
		);
	});
});

describe("courseNotesFor course-update notes", () => {
	// plan 015 part 3: note due only while a material file's update has open items
	it("returns no course-update note when update has no open items", () => {
		const tree = makeTree();
		const baseFile = {
			path: "/course/slides-v2.pdf",
			addedAt: REPLACE_AT,
			via: "learner" as const,
			binding: true,
			status: "assigned" as const,
		};

		const allHandled: CourseMaterial = {
			files: [
				{
					...baseFile,
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 1", method: "Old" }],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n2", kind: "same" },
							{ nodeId: "n3", kind: "dropped" },
						],
						newSections: [{ title: "Extra", pages: "S. 20" }],
						revisited: ["n1"],
						planAsked: true,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 2", method: "New" }],
			conflicts: [],
		};

		const notes = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], tree, allHandled);
		assert.ok(!notes.some((n) => n.customType === "course-update"));
	});

	// plan 015 part 3: planAsked false alone is not open without dropped nodes or new sections
	it("returns no course-update note when planAsked is false but nothing is dropped or uncovered", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [],
						nodes: [{ nodeId: "n1", kind: "same" }],
						newSections: [],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		};
		const notes = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], makeTree(), material);
		assert.ok(!notes.some((n) => n.customType === "course-update"));
	});

	// plan 015 part 3: note applies to material files on teaching turns only
	it("ignores update on non-material files and does not emit course-update in practiceCourseNotesFor", () => {
		const tree = makeTree();
		const refMaterial: CourseMaterial = {
			files: [
				{
					path: "/course/ref-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/ref-v1.pdf",
						previous: [],
						nodes: [{ nodeId: "n1", kind: "dropped" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		};
		assert.ok(!courseNotesFor([], tree, refMaterial).some((n) => n.customType === "course-update"));

		const matMaterial: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "inherited",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 1", method: "Old" }],
						nodes: [{ nodeId: "n1", kind: "changed" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 2", method: "New" }],
			conflicts: [],
		};
		assert.ok(!practiceCourseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], matMaterial).some((n) => n.customType === "course-update"));
	});

	// plan 015 part 3: changed nodes already taught (tags before replacement time) and not in revisited
	it("includes changed nodes taught before update.at and excludes untaught or post-replacement tags", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [
							{ nodeId: "n1", pages: "S. 1", method: "Old 1" },
							{ nodeId: "n2", pages: "S. 2", method: "Old 2" },
							{ nodeId: "n3", pages: "S. 3", method: "Old 3" },
						],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n2", kind: "changed" },
							{ nodeId: "n3", kind: "changed" },
						],
						revisited: [],
						planAsked: true,
					},
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 1", method: "New 1" },
				{ nodeId: "n2", path: "/course/slides-v2.pdf", pages: "S. 2", method: "New 2" },
				{ nodeId: "n3", path: "/course/slides-v2.pdf", pages: "S. 3", method: "New 3" },
			],
			conflicts: [],
		};

		// n1 taught before update.at; n2 untaught; n3 taught only after update.at
		const messages = [quizCall("n1", BEFORE_REPLACE_MS), quizCall("n3", AFTER_REPLACE_MS)];
		const notes = courseNotesFor(messages, tree, material);
		const updateNote = notes.find((n) => n.customType === "course-update");
		assert.ok(updateNote);
		assert.ok(updateNote.content.includes("- `n1` (Node 1), earlier route: Old 1 (S. 1)"));
		assert.ok(!updateNote.content.includes("`n2`"));
		assert.ok(!updateNote.content.includes("`n3`"));

		// Only untaught / post-replacement changed nodes -> no note due
		const noNote = courseNotesFor([quizCall("n3", AFTER_REPLACE_MS)], tree, material);
		assert.ok(!noNote.some((n) => n.customType === "course-update"));
	});

	// plan 015 part 3: course-update note is not limited to the current unit
	it("includes open items from units other than the current unit", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [{ nodeId: "n3", pages: "S. 9", method: "Old 3" }],
						nodes: [
							{ nodeId: "n3", kind: "changed" },
							{ nodeId: "n2", kind: "dropped" },
						],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [{ nodeId: "n3", path: "/course/slides-v2.pdf", pages: "S. 10", method: "New 3" }],
			conflicts: [],
		};

		// Taught n3 (unit 2) earlier, currently back on n1 (unit 1) — wait: currentUnitIndex is furthest reached,
		// so test with n1 in unit 1 taught + n3 in unit 2 dropped while current unit is unit 1.
		const materialUnit1Current: CourseMaterial = {
			...material,
			files: [
				{
					...material.files[0]!,
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 1", method: "Old 1" }],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n3", kind: "dropped" },
						],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 1", method: "New 1" }],
		};

		const notes = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], tree, materialUnit1Current);
		const updateNote = notes.find((n) => n.customType === "course-update");
		assert.ok(updateNote);
		assert.ok(updateNote.content.includes("Steps the new version no longer covers: `n3` (Node 3)"));
	});

	// plan 015 part 3: exact confirmed note text when all groups are non-empty
	it("formats the exact confirmed text when changed routes, dropped steps, and new sections are all present", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/lecture-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/old/lecture-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 4–6", method: "Gaussian elimination" }],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n2", kind: "dropped" },
							{ nodeId: "n3", kind: "dropped" },
						],
						newSections: [
							{ title: "LU Decomposition", pages: "S. 12–15" },
							{ title: "Cholesky", pages: "S. 16–18" },
						],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/lecture-v2.pdf", pages: "S. 4–7", method: "Row reduction" }],
			conflicts: [],
		};

		const notes = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], tree, material);
		const updateNote = notes.find((n) => n.customType === "course-update");
		assert.ok(updateNote);
		assert.equal(
			updateNote.content,
			[
				"[Course update] lecture-v1.pdf was replaced by a newer version, lecture-v2.pdf. The [Course method] notes now show the new routes.",
				"Changed routes in steps already taught. When the learner next works on one of these, or at the next natural pause, point out briefly what changed (earlier route vs the new one) and check the new route once, then call course_update with the node id:",
				"- `n1` (Node 1), earlier route: Gaussian elimination (S. 4–6)",
				"",
				"Steps the new version no longer covers: `n2` (Node 2), `n3` (Node 3)",
				"Sections of the new version no plan step covers: LU Decomposition (S. 12–15); Cholesky (S. 16–18)",
				'Ask the learner with ask_user_question which of these to add as plan steps and which uncovered steps to drop. Rewrite the plan only for what they accept, then call course_update with "plan".',
			].join("\n"),
		);
	});

	// plan 015 part 3: lines for an empty group are left out
	it("omits empty groups from the course-update note", () => {
		const tree = makeTree();
		const onlyNewSections: CourseMaterial = {
			files: [
				{
					path: "/course/lecture-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/old/lecture-v1.pdf",
						previous: [],
						nodes: [],
						newSections: [{ title: "LU Decomposition", pages: "S. 12–15" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		};

		const note1 = courseNotesFor([], tree, onlyNewSections).find((n) => n.customType === "course-update");
		assert.ok(note1);
		assert.equal(
			note1.content,
			[
				"[Course update] lecture-v1.pdf was replaced by a newer version, lecture-v2.pdf. The [Course method] notes now show the new routes.",
				"Sections of the new version no plan step covers: LU Decomposition (S. 12–15)",
				'Ask the learner with ask_user_question which of these to add as plan steps and which uncovered steps to drop. Rewrite the plan only for what they accept, then call course_update with "plan".',
			].join("\n"),
		);

		const onlyDropped: CourseMaterial = {
			...onlyNewSections,
			files: [
				{
					...onlyNewSections.files[0]!,
					update: {
						at: REPLACE_AT,
						fromPath: "/old/lecture-v1.pdf",
						previous: [],
						nodes: [{ nodeId: "n2", kind: "dropped" }],
						newSections: [],
						revisited: [],
						planAsked: false,
					},
				},
			],
		};

		const note2 = courseNotesFor([], tree, onlyDropped).find((n) => n.customType === "course-update");
		assert.ok(note2);
		assert.equal(
			note2.content,
			[
				"[Course update] lecture-v1.pdf was replaced by a newer version, lecture-v2.pdf. The [Course method] notes now show the new routes.",
				"Steps the new version no longer covers: `n2` (Node 2)",
				'Ask the learner with ask_user_question which of these to add as plan steps and which uncovered steps to drop. Rewrite the plan only for what they accept, then call course_update with "plan".',
			].join("\n"),
		);

		const onlyChanged: CourseMaterial = {
			files: [
				{
					...onlyNewSections.files[0]!,
					update: {
						at: REPLACE_AT,
						fromPath: "/old/lecture-v1.pdf",
						previous: [{ nodeId: "n1", pages: "S. 1", method: "Old 1" }],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n2", kind: "dropped" },
						],
						newSections: [{ title: "Extra", pages: "S. 9" }],
						revisited: [],
						planAsked: true,
					},
				},
			],
			methods: [{ nodeId: "n1", path: "/course/lecture-v2.pdf", pages: "S. 1", method: "New 1" }],
			conflicts: [],
		};

		const note3 = courseNotesFor([quizCall("n1", BEFORE_REPLACE_MS)], tree, onlyChanged).find((n) => n.customType === "course-update");
		assert.ok(note3);
		assert.equal(
			note3.content,
			[
				"[Course update] lecture-v1.pdf was replaced by a newer version, lecture-v2.pdf. The [Course method] notes now show the new routes.",
				"Changed routes in steps already taught. When the learner next works on one of these, or at the next natural pause, point out briefly what changed (earlier route vs the new one) and check the new route once, then call course_update with the node id:",
				"- `n1` (Node 1), earlier route: Old 1 (S. 1)",
			].join("\n"),
		);
	});

	// plan 015 part 3: digest rule stops repeats and changes after the tool
	it("does not repeat an unchanged note and re-emits when handled items change the note text", () => {
		const tree = makeTree();
		const messages: LhMessage[] = [quizCall("n1", BEFORE_REPLACE_MS), quizCall("n2", BEFORE_REPLACE_MS)];
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/slides-v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/slides-v1.pdf",
						previous: [
							{ nodeId: "n1", pages: "S. 1", method: "Old 1" },
							{ nodeId: "n2", pages: "S. 2", method: "Old 2" },
						],
						nodes: [
							{ nodeId: "n1", kind: "changed" },
							{ nodeId: "n2", kind: "changed" },
							{ nodeId: "n3", kind: "dropped" },
						],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides-v2.pdf", pages: "S. 1", method: "New 1" },
				{ nodeId: "n2", path: "/course/slides-v2.pdf", pages: "S. 2", method: "New 2" },
			],
			conflicts: [],
		};

		const first = courseNotesFor(messages, tree, initial);
		assert.ok(first.some((n) => n.customType === "course-update"));

		const second = courseNotesFor([...messages, ...first, newUserMessage("next")], tree, initial);
		assert.ok(!second.some((n) => n.customType === "course-update"));

		const afterOneRevisited: CourseMaterial = {
			...initial,
			files: [
				{
					...initial.files[0]!,
					update: {
						...initial.files[0]!.update!,
						revisited: ["n1"],
					},
				},
			],
		};

		const third = courseNotesFor([...messages, ...first], tree, afterOneRevisited);
		const updatedNote = third.find((n) => n.customType === "course-update");
		assert.ok(updatedNote);
		assert.ok(!updatedNote.content.includes("`n1`"));
		assert.ok(updatedNote.content.includes("`n2`"));
		assert.ok(updatedNote.content.includes("`n3`"));
	});
});
