import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor, practiceCourseNotesFor } from "../src/core/course-notes.ts";
import { newCourseFilesNoteMessage } from "../src/core/native-messages.ts";

const tree: PlanTree = { nodes: [{ id: "n1", title: "Mean Value Theorem" }], edges: [], version: 1 };

function materialOf(kind: "complete" | "overview"): CourseMaterial {
	return {
		files: [
			{
				path: "/course/slides.pdf",
				addedAt: "2026-11-25T00:00:00.000Z",
				via: "learner",
				binding: true,
				status: "assigned",
				category: "material",
				materialKind: kind,
			},
		],
		methods: [],
		conflicts: [],
	};
}

describe("material kind change makes the [Course material] note due again", () => {
	it("courseNotesFor re-emits the note when a live file's kind changes, and not when it is unchanged", () => {
		const live = [newCourseFilesNoteMessage(["/course/slides.pdf"], new Set())];
		const same = courseNotesFor(live, tree, materialOf("complete"));
		assert.equal(same.filter((n) => n.customType === "course-files").length, 0);
		const changed = courseNotesFor(live, tree, materialOf("overview"));
		const note = changed.find((n) => n.customType === "course-files");
		assert.ok(note);
		assert.ok(note.content.includes("- /course/slides.pdf (overview)"));
		assert.deepEqual(note.details, { paths: ["/course/slides.pdf"], overview: ["/course/slides.pdf"] });
	});

	it("courseNotesFor re-emits when an overview file becomes complete", () => {
		const live = [newCourseFilesNoteMessage(["/course/slides.pdf"], new Set(["/course/slides.pdf"]))];
		assert.equal(courseNotesFor(live, tree, materialOf("overview")).filter((n) => n.customType === "course-files").length, 0);
		assert.equal(courseNotesFor(live, tree, materialOf("complete")).filter((n) => n.customType === "course-files").length, 1);
	});

	it("practiceCourseNotesFor re-emits when a live file's kind changes", () => {
		const live = [newCourseFilesNoteMessage(["/course/slides.pdf"], new Set())];
		const material: CourseMaterial = {
			...materialOf("overview"),
			propositionMethods: [{ propositionId: "p1", lessonId: "l1", nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "m" }],
		};
		const notes = practiceCourseNotesFor(live, material);
		assert.equal(notes.filter((n) => n.customType === "course-files").length, 1);
	});
});
