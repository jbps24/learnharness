import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor } from "../src/core/course-notes.ts";
import { failedResponseAtEnd } from "../src/core/input-events.ts";
import {
	nativeInputCause,
	newCourseFilesNoteMessage,
	newCourseMethodNoteMessage,
	newMessageId,
	newUserMessage,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

function quizCall(nodeId: string, id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${nodeId}`,
				name: "quiz",
				arguments: { nodeId },
			},
		],
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

function lessonRecordMarker(firstKeptMessageId: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "lesson-record",
		content: "[LESSON RECORD]",
		display: true,
		details: {
			firstKeptMessageId,
			finishedUnitIds: ["u1"],
			currentUnitId: "u2",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-22T00:00:00.000Z",
		},
		timestamp: 50,
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

describe("course note markers and transcript folds", () => {
	// plan 007 part 4: newCourseFilesNoteMessage and newCourseMethodNoteMessage set display: false, details, neutral cause, and wire user text
	it("constructs course-files and course-method markers as neutral user-wire notes", () => {
		const filesMsg = newCourseFilesNoteMessage(["/course/a.pdf", "/course/b.pdf"]);
		assert.equal(filesMsg.customType, "course-files");
		assert.equal(filesMsg.display, false);
		assert.deepEqual(filesMsg.details, { paths: ["/course/a.pdf", "/course/b.pdf"] });
		assert.equal(
			filesMsg.content,
			[
				"[Course material] This lesson's course files (their methods are binding):",
				"- /course/a.pdf",
				"- /course/b.pdf",
				"",
				"Files the learner switched off are not listed and no longer bind.",
			].join("\n"),
		);
		assert.equal(nativeInputCause(filesMsg, []), "neutral");
		assert.deepEqual(toLlmMessages([filesMsg]), [
			{ role: "user", content: [{ type: "text", text: filesMsg.content }], timestamp: filesMsg.timestamp },
		]);

		const methodMsg = newCourseMethodNoteMessage("n1", "method text", "digest-1");
		assert.equal(methodMsg.customType, "course-method");
		assert.equal(methodMsg.display, false);
		assert.deepEqual(methodMsg.details, { nodeId: "n1", digest: "digest-1" });
		assert.equal(methodMsg.content, "method text");
		assert.equal(nativeInputCause(methodMsg, []), "neutral");
		assert.deepEqual(toLlmMessages([methodMsg]), [
			{ role: "user", content: [{ type: "text", text: "method text" }], timestamp: methodMsg.timestamp },
		]);
	});

	// plan 007 part 4: failedResponseAtEnd skips course-files and course-method markers
	it("ignores course-files and course-method markers in failedResponseAtEnd", () => {
		const user = newUserMessage("hi");
		const err = failedAssistant();
		const filesMsg = newCourseFilesNoteMessage(["/course/a.pdf"]);
		const methodMsg = newCourseMethodNoteMessage("n1", "method text", "digest-1");

		assert.equal(failedResponseAtEnd([user, err, filesMsg, methodMsg])?.id, err.id);
	});
});

describe("courseNotesFor", () => {
	// plan 007 part 4: with no material (or no binding files), there are no notes
	it("returns no notes when material is undefined or has no binding files", () => {
		const tree = makeTree();
		assert.deepEqual(courseNotesFor([], tree, undefined), []);

		const allUnticked: CourseMaterial = {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Route A" }],
			conflicts: [],
		};
		assert.deepEqual(courseNotesFor([], tree, allUnticked), []);
	});

	// plan 007 part 4: before any tagged call, scope is the first unit; notes are ordered course-files first, then nodes in map order
	it("emits sorted course-files first then first-unit course-method notes in map order before any tagged call", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "tutor", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n3", path: "/course/a.pdf", pages: "S. 9", method: "Method 3" },
				{ nodeId: "n2", path: "/course/b.pdf", pages: "S. 5", method: "Method 2" },
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method 1" },
			],
			conflicts: [],
		};

		const notes = courseNotesFor([], tree, material);
		assert.equal(notes.length, 3);
		assert.equal(notes[0]!.customType, "course-files");
		assert.deepEqual(notes[0]!.details, { paths: ["/course/a.pdf", "/course/b.pdf"] });
		assert.equal(
			notes[0]!.content,
			[
				"[Course material] This lesson's course files (their methods are binding):",
				"- /course/a.pdf",
				"- /course/b.pdf",
				"",
				"Files the learner switched off are not listed and no longer bind.",
			].join("\n"),
		);

		assert.equal(notes[1]!.customType, "course-method");
		assert.equal((notes[1]!.details as { nodeId: string }).nodeId, "n1");
		assert.equal(
			notes[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method 1 (a.pdf, S. 1)",
			].join("\n"),
		);

		assert.equal(notes[2]!.customType, "course-method");
		assert.equal((notes[2]!.details as { nodeId: string }).nodeId, "n2");
		assert.equal(
			notes[2]!.content,
			[
				"[Course method] Node `n2` (Node 2): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method 2 (b.pdf, S. 5)",
			].join("\n"),
		);
	});

	// plan 007 part 4: with no units, all nodes are in scope
	it("includes all nodes in map order when the plan has no units", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Node 1" },
				{ id: "n2", title: "Node 2" },
			],
			edges: [{ from: "n1", to: "n2" }],
			version: 1,
		};
		const material: CourseMaterial = {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [
				{ nodeId: "n2", path: "/course/a.pdf", pages: "p. 4", method: "M2" },
				{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "M1" },
			],
			conflicts: [],
		};

		const notes = courseNotesFor([], tree, material);
		assert.deepEqual(
			notes.map((n) => n.customType === "course-files" ? "course-files" : (n.details as { nodeId: string }).nodeId),
			["course-files", "n1", "n2"],
		);
	});

	// plan 007 part 4: entering unit 2 makes notes due for unit 2's nodes only
	it("emits course-method notes only for unit 2 nodes after entering unit 2", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method 1" },
				{ nodeId: "n3", path: "/course/a.pdf", pages: "S. 9", method: "Method 3" },
			],
			conflicts: [],
		};
		const messages: LhMessage[] = [quizCall("n3")];

		const notes = courseNotesFor(messages, tree, material);
		assert.deepEqual(
			notes.map((n) => n.customType === "course-files" ? "course-files" : (n.details as { nodeId: string }).nodeId),
			["course-files", "n3"],
		);
	});

	// plan 007 part 4: a second input with the notes live makes nothing due
	it("returns nothing when the exact notes are already live", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method 1" }],
			conflicts: [],
		};
		const first = courseNotesFor([], tree, material);
		assert.equal(first.length, 2);
		assert.deepEqual(courseNotesFor([...first, newUserMessage("continue")], tree, material), []);
	});

	// plan 007 part 4: after a lesson-record cut, the notes are due again
	it("re-emits notes after a lesson-record cut moves projectionHeads.start past prior notes", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method 1" },
				{ nodeId: "n3", path: "/course/a.pdf", pages: "S. 9", method: "Method 3" },
			],
			conflicts: [],
		};
		const unit2Call = quizCall("n3");
		const priorNotes = courseNotesFor([unit2Call], tree, material);
		assert.equal(priorNotes.length, 2);

		const messages: LhMessage[] = [
			...priorNotes,
			lessonRecordMarker(unit2Call.id),
			unit2Call,
		];
		const afterCut = courseNotesFor(messages, tree, material);
		assert.deepEqual(
			afterCut.map((n) => n.customType === "course-files" ? "course-files" : (n.details as { nodeId: string }).nodeId),
			["course-files", "n3"],
		);
	});

	// plan 007 part 4: unticking a file changes the course-files note and drops that file's method from the node note
	it("updates course-files and drops an unticked file's method from a multi-file node note", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1–2", method: "Method A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "S. 3–4", method: "Method B" },
			],
			conflicts: [],
		};

		const first = courseNotesFor([], tree, material);
		assert.equal(first.length, 2);
		assert.equal(
			first[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method A (a.pdf, S. 1–2)",
				"Method B (b.pdf, S. 3–4)",
			].join("\n"),
		);

		const unticked: CourseMaterial = {
			...material,
			files: [
				material.files[0]!,
				{ ...material.files[1]!, binding: false },
			],
		};
		const updated = courseNotesFor(first, tree, unticked);
		assert.equal(updated.length, 2);
		assert.equal(updated[0]!.customType, "course-files");
		assert.deepEqual(updated[0]!.details, { paths: ["/course/a.pdf"] });
		assert.equal(updated[1]!.customType, "course-method");
		assert.equal(
			updated[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method A (a.pdf, S. 1–2)",
			].join("\n"),
		);
	});

	// plan 007 part 4: course-files is compared with the newest live course-files note, so re-ticking a file is due again
	it("compares against the newest live course-files note when a file is re-ticked", () => {
		const tree = makeTree();
		const file = (path: string, binding: boolean) => ({
			path, addedAt: "2026-11-22T00:00:00.000Z", via: "learner" as const, binding, status: "assigned" as const,
		});
		const both: CourseMaterial = { files: [file("/course/a.pdf", true), file("/course/b.pdf", true)], methods: [], conflicts: [] };
		const onlyA: CourseMaterial = { files: [file("/course/a.pdf", true), file("/course/b.pdf", false)], methods: [], conflicts: [] };

		const transcript = [
			newCourseFilesNoteMessage(["/course/a.pdf", "/course/b.pdf"]),
			newCourseFilesNoteMessage(["/course/a.pdf"]),
		];
		assert.deepEqual(courseNotesFor(transcript, tree, onlyA), []);

		const notes = courseNotesFor(transcript, tree, both);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.customType, "course-files");
		assert.deepEqual(notes[0]!.details, { paths: ["/course/a.pdf", "/course/b.pdf"] });
	});

	// plan 007 part 4: an unresolved conflict gives the conflict text, and after resolution gives the single-route text
	it("emits the conflict note when unresolved and a fresh single-route note after chosen is set", () => {
		const tree = makeTree();
		const unresolved: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1–2", method: "Method A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "S. 3–4", method: "Method B" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
		};

		const first = courseNotesFor([], tree, unresolved);
		assert.equal(first.length, 2);
		assert.equal(first[1]!.customType, "course-method");
		assert.equal(
			first[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the course files describe different routes:",
				"A — a.pdf, S. 1–2: Method A",
				"B — b.pdf, S. 3–4: Method B",
				"",
				"Before you teach or check this node, ask the learner with ask_user_question which route their course uses (one option per file), then call course_route with the node id and the chosen file's path.",
			].join("\n"),
		);

		const resolved: CourseMaterial = {
			...unresolved,
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/b.pdf" }],
		};
		const next = courseNotesFor(first, tree, resolved);
		assert.equal(next.length, 1);
		assert.equal(next[0]!.customType, "course-method");
		assert.notEqual(
			(next[0]!.details as { digest: string }).digest,
			(first[1]!.details as { digest: string }).digest,
		);
		assert.equal(
			next[0]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method B (b.pdf, S. 3–4)",
			].join("\n"),
		);
	});

	// plan 007 part 4: a conflict counts only while at least two of its paths are binding
	it("treats a conflict as non-conflicting when fewer than two conflicting paths are binding", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: false, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1–2", method: "Method A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "S. 3–4", method: "Method B" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
		};

		const notes = courseNotesFor([], tree, material);
		assert.equal(notes.length, 2);
		assert.equal(
			notes[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Method A (a.pdf, S. 1–2)",
			].join("\n"),
		);
	});
});
