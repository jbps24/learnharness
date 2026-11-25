import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { courseNotesFor, practiceCourseNotesFor } from "../src/core/course-notes.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function makePlanTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Mean Value Theorem" },
			{ id: "n2", title: "Chain Rule" },
		],
		edges: [{ from: "n1", to: "n2" }],
		version: 1,
	};
}

describe("book-route courseNotesFor and practiceCourseNotesFor", () => {
	// plan 020 part 4: [Course method] note for an Overview node with a stored, non-failed book route from a binding reference file
	it("renders Overview+book [Course method] note when all binding routes are Overview and a binding non-failed book route exists", () => {
		const tree = makePlanTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "State MVT with f'(c) = (f(b)-f(a))/(b-a)" },
			],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 102-104", method: "Apply Rolle's theorem to g(x) = f(x) - L(x)" },
			],
		};

		const notes = courseNotesFor([], tree, material);
		const methodNote = notes.find((n) => n.customType === "course-method" && (n.details as { nodeId: string }).nodeId === "n1");
		assert.ok(methodNote);
		assert.equal(
			methodNote.content,
			[
				"[Course method] Node `n1` (Mean Value Theorem): the learner's course material for this node is an overview. What is taught, in which order, and with which results and notation comes from it:",
				"State MVT with f'(c) = (f(b)-f(a))/(b-a) (slides.pdf, S. 4)",
				"",
				"How the course gets there, from the book it was built from. Teach, check and grade by this derivation, in the notation above:",
				"Apply Rolle's theorem to g(x) = f(x) - L(x) (book.pdf, pp. 102-104)",
			].join("\n"),
		);
	});

	// plan 020 part 4: a node with any Complete route gets no book route in [Course method] note
	it("keeps standard [Course method] note when node has a Complete route even if a book route exists", () => {
		const tree = makePlanTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/script.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "complete",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/script.pdf", pages: "S. 12", method: "Prove via auxiliary function h(x)" },
			],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 102-104", method: "Apply Rolle's theorem to g(x)" },
			],
		};

		const notes = courseNotesFor([], tree, material);
		const methodNote = notes.find((n) => n.customType === "course-method" && (n.details as { nodeId: string }).nodeId === "n1");
		assert.ok(methodNote);
		assert.equal(
			methodNote.content,
			[
				"[Course method] Node `n1` (Mean Value Theorem): the learner's course works this as follows. Teach, check and grade exactly this route:",
				"Prove via auxiliary function h(x) (script.pdf, S. 12)",
			].join("\n"),
		);
	});

	function mixedMaterial(completeBinding: boolean): CourseMaterial {
		const base = { addedAt: "2026-11-25T00:00:00.000Z", via: "learner" as const, status: "assigned" as const };
		return {
			files: [
				{ ...base, path: "/course/slides.pdf", binding: true, category: "material", materialKind: "overview" },
				{ ...base, path: "/course/script.pdf", binding: completeBinding, category: "material", materialKind: "complete" },
				{ ...base, path: "/course/book.pdf", binding: true, category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" },
				{ nodeId: "n1", path: "/course/script.pdf", pages: "S. 1", method: "Script route" },
			],
			conflicts: [],
			bookRoutes: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10-12", method: "Book derivation" }],
		};
	}

	// plan 020 part 4: a node with any Complete binding route (mixed with Overview) gets no book route
	it("keeps the standard note without the book route for mixed Overview and Complete binding routes", () => {
		const notes = courseNotesFor([], makePlanTree(), mixedMaterial(true));
		const methodNote = notes.find((n) => n.customType === "course-method" && (n.details as { nodeId: string }).nodeId === "n1");
		assert.ok(methodNote);
		assert.ok(!methodNote.content.includes("How the course gets there, from the book it was built from."));
		assert.ok(!methodNote.content.includes("Book derivation"));
	});

	// plan 020 part 4: only binding routes count, so a non-binding Complete file leaves an all-Overview node
	it("renders the book route when the only Complete file is non-binding", () => {
		const notes = courseNotesFor([], makePlanTree(), mixedMaterial(false));
		const methodNote = notes.find((n) => n.customType === "course-method" && (n.details as { nodeId: string }).nodeId === "n1");
		assert.ok(methodNote);
		assert.ok(methodNote.content.includes("How the course gets there, from the book it was built from."));
		assert.ok(methodNote.content.includes("Book derivation (book.pdf, pp. 10-12)"));
	});

	// plan 020 part 4: only stored, non-failed book routes from a binding reference file trigger the Overview+book note
	it("keeps standard [Course method] note when book route is missing, failed, or from a non-binding reference file", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "n1", title: "No Book" },
				{ id: "n2", title: "Failed Book" },
				{ id: "n3", title: "Unbound Book" },
			],
			edges: [],
			version: 1,
		};
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book-bound.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
				{
					path: "/course/book-unbound.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 1", method: "Slide route 1" },
				{ nodeId: "n2", path: "/course/slides.pdf", pages: "S. 2", method: "Slide route 2" },
				{ nodeId: "n3", path: "/course/slides.pdf", pages: "S. 3", method: "Slide route 3" },
			],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n2", path: "/course/book-bound.pdf", sectionIds: ["s2"], pages: "", method: "", error: "Section unreadable" },
				{ nodeId: "n3", path: "/course/book-unbound.pdf", sectionIds: ["s3"], pages: "p. 50", method: "Book route 3" },
			],
		};

		const notes = courseNotesFor([], tree, material).filter((n) => n.customType === "course-method");
		assert.equal(notes.length, 3);
		for (const note of notes) {
			assert.ok(note.content.includes("the learner's course works this as follows. Teach, check and grade exactly this route:"));
			assert.ok(!note.content.includes("How the course gets there, from the book it was built from."));
		}
	});

	// plan 020 part 4: conflict branch unchanged (conflicts are between material files only)
	it("keeps conflict branch unchanged for conflicting Overview files even when a book route exists", () => {
		const tree = makePlanTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides-a.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/slides-b.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides-a.pdf", pages: "S. 4", method: "Route A" },
				{ nodeId: "n1", path: "/course/slides-b.pdf", pages: "S. 8", method: "Route B" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/slides-a.pdf", "/course/slides-b.pdf"] },
			],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10-12", method: "Book route" },
			],
		};

		const notes = courseNotesFor([], tree, material);
		const methodNote = notes.find((n) => n.customType === "course-method" && (n.details as { nodeId: string }).nodeId === "n1");
		assert.ok(methodNote);
		assert.ok(methodNote.content.includes("the course files describe different routes:"));
		assert.ok(methodNote.content.includes("A — slides-a.pdf, S. 4: Route A"));
		assert.ok(methodNote.content.includes("B — slides-b.pdf, S. 8: Route B"));
	});

	// plan 020 part 4: digest as today, so a newly stored book route makes the note due again
	it("re-emits [Course method] note when a book route is newly stored after the initial note was already live", () => {
		const tree: PlanTree = { nodes: [{ id: "n1", title: "Mean Value Theorem" }], edges: [], version: 1 };
		const beforeBook: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" },
			],
			conflicts: [],
		};

		const initialNotes = courseNotesFor([], tree, beforeBook);
		const liveMessages: LhMessage[] = [...initialNotes];
		assert.deepEqual(courseNotesFor(liveMessages, tree, beforeBook), []);

		const withBook: CourseMaterial = {
			...beforeBook,
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10-12", method: "Book derivation" },
			],
		};
		const dueNotes = courseNotesFor(liveMessages, tree, withBook);
		const methodNotes = dueNotes.filter((n) => n.customType === "course-method");
		assert.equal(methodNotes.length, 1);
		assert.ok(methodNotes[0]!.content.includes("How the course gets there, from the book it was built from."));
		assert.ok(methodNotes[0]!.content.includes("Book derivation (book.pdf, pp. 10-12)"));
	});

	// plan 020 part 4: [Course material] note appends ' (overview)' to Overview files; Complete files unchanged
	it("appends (overview) to Overview files in [Course material] note while leaving Complete files unchanged", () => {
		const tree = makePlanTree();
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/a-slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/b-script.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "complete",
				},
				{
					path: "/course/c-default.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
			],
			methods: [],
			conflicts: [],
		};

		const notes = courseNotesFor([], tree, material);
		const filesNote = notes.find((n) => n.customType === "course-files");
		assert.ok(filesNote);
		assert.equal(
			filesNote.content,
			[
				"[Course material] This lesson's course files (their methods are binding):",
				"- /course/a-slides.pdf (overview)",
				"- /course/b-script.pdf",
				"- /course/c-default.pdf",
				"",
				"Files the learner switched off are not listed and no longer bind.",
			].join("\n"),
		);
	});

	// plan 020 part 4: practice note renders book routes as their own line under the proposition
	it("renders role: 'book' PropositionMethod entries with the confirmed how (book) line in practiceCourseNotesFor", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "inherited",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
			],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{
					propositionId: "prop_1",
					lessonId: "lesson_1",
					nodeId: "n1",
					path: "/course/slides.pdf",
					pages: "S. 4",
					method: "Use MVT formula",
				},
				{
					propositionId: "prop_1",
					lessonId: "lesson_1",
					nodeId: "n1",
					role: "book",
					path: "/course/book.pdf",
					pages: "pp. 102-104",
					method: "Apply Rolle's theorem to g(x)",
				},
			],
		};

		const notes = practiceCourseNotesFor([], material);
		// plan 020 part 4: the [Course material] note of a practice session also marks Overview files
		const filesNote = notes.find((n) => n.customType === "course-files");
		assert.ok(filesNote);
		assert.ok(filesNote.content.includes("/course/slides.pdf (overview)"));
		const methodNote = notes.find((n) => n.customType === "course-method");
		assert.ok(methodNote);
		assert.equal(
			methodNote.content,
			[
				"[Course method] The learner's course solves these propositions as follows. Model solutions, hints and verdicts follow exactly these routes:",
				"- [prop_1] (from node `n1`): Use MVT formula (slides.pdf, S. 4)",
				"- [prop_1] (from node `n1`), how (book): Apply Rolle's theorem to g(x) (book.pdf, pp. 102-104)",
			].join("\n"),
		);
	});

	it("ignores book routes that have an error despite non-empty method or an empty method without error", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Errored With Method" },
				{ id: "n2", title: "Empty Method Without Error" },
			],
			edges: [],
			version: 1,
		};
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 1", method: "Slide 1" },
				{ nodeId: "n2", path: "/course/slides.pdf", pages: "S. 2", method: "Slide 2" },
			],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 1", method: "Partial text", error: "Failed" },
				{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"], pages: "", method: "" },
			],
		};

		const notes = courseNotesFor([], tree, material).filter((n) => n.customType === "course-method");
		assert.equal(notes.length, 2);
		for (const note of notes) {
			assert.ok(note.content.includes("the learner's course works this as follows. Teach, check and grade exactly this route:"));
			assert.ok(!note.content.includes("How the course gets there, from the book it was built from."));
		}
	});
});
