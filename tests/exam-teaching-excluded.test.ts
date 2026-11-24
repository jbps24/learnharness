import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor } from "../src/core/course-notes.ts";

function makeTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
		],
		edges: [{ from: "n1", to: "n2" }],
		version: 1,
	};
}

describe("courseNotesFor (exam files excluded)", () => {
	// plan 010 part 3: courseNotesFor leaves exam files out of course-files and never produces method notes for them
	it("returns no notes when a teaching lesson only has binding exam files", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
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
			methods: [{ nodeId: "n1", path: "/course/ws22.pdf", pages: "S. 2", method: "Should never appear" }],
			conflicts: [],
			examPatterns: [{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pattern: "Exam task" }],
		};

		assert.deepEqual(courseNotesFor([], tree, material), []);
	});

	// plan 010 part 3: courseNotesFor keeps course material files while leaving exam files out of course-files and method notes
	it("excludes exam files from course-files and course-method notes when mixed with course material", () => {
		const tree = makeTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/notes.pdf", pages: "S. 1", method: "Course route" },
				{ nodeId: "n1", path: "/course/ws22.pdf", pages: "S. 2", method: "Exam route" },
			],
			conflicts: [],
			examPatterns: [{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pattern: "Exam task" }],
		};

		const notes = courseNotesFor([], tree, material);
		assert.equal(notes.length, 2);
		assert.equal(notes[0]!.customType, "course-files");
		assert.deepEqual(notes[0]!.details, { paths: ["/course/notes.pdf"] });
		assert.ok(!notes[0]!.content.includes("/course/ws22.pdf"));
		assert.equal(notes[1]!.customType, "course-method");
		assert.equal(
			notes[1]!.content,
			[
				"[Course method] Node `n1` (Node 1): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Course route (notes.pdf, S. 1)",
			].join("\n"),
		);
	});
});
