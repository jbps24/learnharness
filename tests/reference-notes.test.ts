import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor, practiceCourseNotesFor } from "../src/core/course-notes.ts";
import { failedResponseAtEnd, retryableReply } from "../src/core/input-events.ts";
import {
	nativeInputCause,
	newMessageId,
	newReferenceNoteMessage,
	newUserMessage,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { spanKeyOf } from "../src/server/unit-cut.ts";

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
			at: "2026-11-24T00:00:00.000Z",
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

describe("reference note markers and transcript folds", () => {
	// plan 012 part 4: customType "reference", neutral, display: false, projects to user wire text
	it("constructs reference markers as neutral non-displayed user-wire notes", () => {
		const refMsg = newReferenceNoteMessage("reference text", "digest-ref-1");
		assert.equal(refMsg.customType, "reference");
		assert.equal(refMsg.display, false);
		assert.deepEqual(refMsg.details, { digest: "digest-ref-1" });
		assert.equal(refMsg.content, "reference text");
		assert.equal(nativeInputCause(refMsg, []), "neutral");
		assert.deepEqual(toLlmMessages([refMsg]), [
			{ role: "user", content: [{ type: "text", text: "reference text" }], timestamp: refMsg.timestamp },
		]);
	});

	// plan 012 part 4: reference uses the same skip lists as course-method in input-events.ts and unit-cut.ts withoutMarkers
	it("ignores reference markers in failedResponseAtEnd, spanKeyOf, and retryableReply", () => {
		const user = newUserMessage("hi");
		const err = failedAssistant();
		const refMsg = newReferenceNoteMessage("reference text", "digest-ref-1");

		assert.equal(failedResponseAtEnd([user, err, refMsg])?.id, err.id);

		const tail = newUserMessage("next");
		assert.equal(
			spanKeyOf([user, err, tail], 0, 3, "rec_1"),
			spanKeyOf([user, refMsg, err, tail], 0, 4, "rec_1"),
		);

		const reply = assistantStop("answer");
		assert.deepEqual(
			retryableReply([user, refMsg, reply]),
			[reply.id],
		);
	});
});

describe("courseNotesFor reference notes", () => {
	// plan 012 part 4: no reference note when material is undefined or has no binding reference files
	it("returns no reference note when material is undefined or has no binding reference files", () => {
		const tree = makeTree();
		assert.deepEqual(courseNotesFor([], tree, undefined), []);

		const untickedRef: CourseMaterial = {
			files: [
				{
					path: "/course/ref.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref.pdf",
					from: "outline",
					sections: [{ id: "1.2", title: "Chain Rule", level: 2, startPage: 10, endPage: 15, label: "10–15" }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["1.2"] }],
		};
		assert.deepEqual(courseNotesFor([], tree, untickedRef), []);
	});

	// plan 012 part 4: confirmed reference note format; reference files stay out of [Course material] note
	it("emits one reference note with the confirmed format and excludes reference files from course-files", () => {
		const tree = makeTree();
		const refOnly: CourseMaterial = {
			files: [
				{
					path: "/course/ref.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref.pdf",
					from: "outline",
					sections: [{ id: "1.2", title: "Chain Rule", level: 2, startPage: 10, endPage: 15, label: "10–15" }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["1.2"] }],
		};

		const notes = courseNotesFor([], tree, refOnly);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.customType, "reference");
		assert.equal(notes[0]!.display, false);
		assert.equal(typeof (notes[0]!.details as { digest?: unknown } | null)?.digest, "string");
		assert.equal(
			notes[0]!.content,
			[
				"[Reference] Reference files for this course. They are not course material: they never set what is learned.",
				"- /course/ref.pdf",
				"",
				"Where to look for this unit's nodes:",
				"- `n1` (Node 1): ref.pdf §1.2 Chain Rule (pages 10–15, printed 10–15)",
				"",
				"When the learner asks something the course material doesn't answer, or the material leaves a step open, look it up here first: a pdf job with this file, these pages and your question.",
			].join("\n"),
		);

		const withMaterial: CourseMaterial = {
			...refOnly,
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
				...refOnly.files,
			],
		};
		const mixedNotes = courseNotesFor([], tree, withMaterial);
		const courseFilesNote = mixedNotes.find((n) => n.customType === "course-files");
		assert.ok(courseFilesNote);
		assert.deepEqual(courseFilesNote.details, { paths: ["/course/slides.pdf"] });
		assert.ok(!courseFilesNote.content.includes("/course/ref.pdf"));
	});

	// plan 012 part 4: reference note scopes pointers to the current unit's nodes (or all nodes when no units)
	it("scopes reference pointers to the current unit and includes all nodes when no units exist", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/ref.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref.pdf",
					from: "outline",
					sections: [
						{ id: "1.1", title: "Basics", level: 2, startPage: 2, endPage: 5, label: "2–5" },
						{ id: "2.1", title: "Advanced", level: 2, startPage: 20, endPage: 25, label: "20–25" },
					],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["1.1"] },
				{ nodeId: "n3", path: "/course/ref.pdf", sectionIds: ["2.1"] },
			],
		};

		const unit1Notes = courseNotesFor([], tree, material);
		assert.equal(unit1Notes.length, 1);
		assert.ok(unit1Notes[0]!.content.includes("`n1` (Node 1): ref.pdf §1.1 Basics (pages 2–5, printed 2–5)"));
		assert.ok(!unit1Notes[0]!.content.includes("`n3`"));

		const unit2Notes = courseNotesFor([quizCall("n3")], tree, material);
		assert.equal(unit2Notes.length, 1);
		assert.ok(unit2Notes[0]!.content.includes("`n3` (Node 3): ref.pdf §2.1 Advanced (pages 20–25, printed 20–25)"));
		assert.ok(!unit2Notes[0]!.content.includes("`n1`"));

		const unitlessTree: PlanTree = {
			nodes: tree.nodes,
			edges: tree.edges,
			version: 1,
		};
		const unitlessNotes = courseNotesFor([], unitlessTree, material);
		assert.equal(unitlessNotes.length, 1);
		assert.ok(unitlessNotes[0]!.content.includes("`n1` (Node 1):"));
		assert.ok(unitlessNotes[0]!.content.includes("`n3` (Node 3):"));
	});

	// plan 012 part 4: due when no live note carries its digest; re-emitted after lesson-record cut
	it("deduplicates by digest while live and re-emits after a lesson-record cut", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/ref.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref.pdf",
					from: "outline",
					sections: [{ id: "2.1", title: "Advanced", level: 2, startPage: 20, endPage: 25, label: "20–25" }],
				},
			],
			referencePointers: [{ nodeId: "n3", path: "/course/ref.pdf", sectionIds: ["2.1"] }],
		};

		const unit2Call = quizCall("n3");
		const first = courseNotesFor([unit2Call], tree, material);
		assert.equal(first.length, 1);
		assert.deepEqual(courseNotesFor([unit2Call, ...first, newUserMessage("next")], tree, material), []);

		const afterCut = courseNotesFor([...first, lessonRecordMarker(unit2Call.id), unit2Call], tree, material);
		assert.equal(afterCut.length, 1);
		assert.equal(afterCut[0]!.customType, "reference");
	});

	// plan 012 part 4: unticking one binding reference file updates the reference note and its digest
	it("updates the reference note and digest when a binding reference file is unticked", () => {
		const tree = makeTree();
		const both: CourseMaterial = {
			files: [
				{ path: "/course/ref-a.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				{ path: "/course/ref-b.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{ path: "/course/ref-a.pdf", from: "outline", sections: [{ id: "1.1", title: "Alpha", level: 2, startPage: 1, endPage: 4, label: "1–4" }] },
				{ path: "/course/ref-b.pdf", from: "outline", sections: [{ id: "1.2", title: "Beta", level: 2, startPage: 5, endPage: 8, label: "5–8" }] },
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/ref-a.pdf", sectionIds: ["1.1"] },
				{ nodeId: "n2", path: "/course/ref-b.pdf", sectionIds: ["1.2"] },
			],
		};
		const first = courseNotesFor([], tree, both);
		assert.equal(first.length, 1);
		assert.ok(first[0]!.content.includes("- /course/ref-a.pdf"));
		assert.ok(first[0]!.content.includes("- /course/ref-b.pdf"));

		const onlyA: CourseMaterial = {
			...both,
			files: [both.files[0]!, { ...both.files[1]!, binding: false }],
		};
		const updated = courseNotesFor(first, tree, onlyA);
		assert.equal(updated.length, 1);
		assert.equal(updated[0]!.customType, "reference");
		assert.ok(updated[0]!.content.includes("- /course/ref-a.pdf"));
		assert.ok(!updated[0]!.content.includes("- /course/ref-b.pdf"));
		assert.ok(!updated[0]!.content.includes("ref-b.pdf"));
		assert.notEqual(
			(updated[0]!.details as { digest: string }).digest,
			(first[0]!.details as { digest: string }).digest,
		);
	});

	// plan 012 decision 4 / part 4: teaching only; practice sessions are unchanged
	it("does not emit a reference note in practiceCourseNotesFor", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/ref.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "inherited",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref.pdf",
					from: "outline",
					sections: [{ id: "1.1", title: "Alpha", level: 2, startPage: 1, endPage: 4, label: "1–4" }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["1.1"] }],
		};

		const notes = practiceCourseNotesFor([], material);
		assert.ok(!notes.some((n) => n.customType === "reference"));
	});
});
