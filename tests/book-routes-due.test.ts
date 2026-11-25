import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BOOK_ROUTE_INSTRUCTIONS,
	bookRouteTargets,
	clearFailedBookRoutes,
	parseBookRoute,
} from "../src/core/book-routes.ts";
import { BOOK_ROUTE_CAP, type CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";

const TREE: PlanTree = {
	nodes: [
		{ id: "n1", title: "Laplace Transform", summary: "Definition and ROC" },
		{ id: "n2", title: "Poles and Zeros", summary: "Stability in s-plane" },
	],
	edges: [],
	version: 1,
};

const FILE_TIME = "2026-11-25T00:00:00.000Z";

describe("BOOK_ROUTE_INSTRUCTIONS", () => {
	// plan 020 part 3: confirmed book-route instructions verbatim
	it("matches the owner-confirmed book-route instructions verbatim", () => {
		assert.equal(
			BOOK_ROUTE_INSTRUCTIONS,
			'You read sections of a reference book for one plan node of a learning application. The course\'s own material for this node is an overview: it sets what is learned and shows the results, but not how the course gets there. The book is what the course was built from, so its derivation is how the learner has to work this node. Write down the book\'s route for this node: the derivation or procedure step by step, with its assumptions and intermediate results, in the book\'s order, so a tutor can teach and grade by it without the book. Cover what the overview route below shows; leave out the book\'s further topics. Where the overview names the same quantity, use the overview\'s notation and say where the book\'s differs. Cite the book\'s printed pages, e.g. (p. 187). Never fill a gap from your own knowledge. Return ONE JSON object and nothing else: {"pages":string,"method":string}, the method at most 2,500 characters. If these pages don\'t cover the node, return {"pages":"","method":""}.',
		);
	});
});

describe("bookRouteTargets", () => {
	// plan 020 part 3: node is due when (a) >= 1 binding material method, (b) every binding material method is overview, (c) binding reference pointer has >= 1 section
	it("returns one target per (node, reference file) when all three conditions hold", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book1.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
				{ path: "/course/book2.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview method" },
			],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book1.pdf", sectionIds: ["s1", "s2"] },
				{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s3"] },
			],
		};

		const result = bookRouteTargets(material, TREE);
		assert.deepEqual(result.targets, [
			{ nodeId: "n1", path: "/course/book1.pdf", sectionIds: ["s1", "s2"] },
			{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s3"] },
		]);
	});

	// plan 020 part 3: condition (a) requires at least one binding material file with a method
	it("excludes nodes with no methods or only unticked material methods", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: false, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Unticked overview" }],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
				{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
			],
		};

		assert.deepEqual(bookRouteTargets(material, TREE).targets, []);
	});

	// plan 020 part 3: condition (b) excludes nodes with any binding complete (or unlabelled, defaulting to complete) material file
	it("excludes nodes when any binding material file with a method is complete or unlabelled", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/script.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
				{ path: "/course/unlabelled.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" },
				{ nodeId: "n1", path: "/course/script.pdf", method: "Complete" },
				{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview" },
				{ nodeId: "n2", path: "/course/unlabelled.pdf", method: "Unlabelled" },
			],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
				{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
			],
		};

		assert.deepEqual(bookRouteTargets(material, TREE).targets, []);
	});

	// plan 020 part 3: condition (b) ignores unticked complete files and allows multiple binding overview files
	it("marks a node due when all binding material methods are overview even if an unticked complete file has a method", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides1.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/slides2.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/script.pdf", addedAt: FILE_TIME, via: "learner", binding: false, status: "assigned", category: "material", materialKind: "complete" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides1.pdf", method: "Overview 1" },
				{ nodeId: "n1", path: "/course/slides2.pdf", method: "Overview 2" },
				{ nodeId: "n1", path: "/course/script.pdf", method: "Unticked complete" },
			],
			conflicts: [],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		};

		assert.deepEqual(bookRouteTargets(material, TREE).targets, [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);
	});

	// plan 020 part 3: condition (c) ignores unticked reference files and pointers with no sections
	it("ignores unticked reference files and pointers with empty sectionIds", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book-unticked.pdf", addedAt: FILE_TIME, via: "learner", binding: false, status: "assigned", category: "reference" },
				{ path: "/course/book-empty.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book-unticked.pdf", sectionIds: ["s1"] },
				{ nodeId: "n1", path: "/course/book-empty.pdf", sectionIds: [] },
			],
		};

		assert.deepEqual(bookRouteTargets(material, TREE).targets, []);
	});

	// plan 020 part 3: stored BookRoute satisfies target when path matches and sectionIds equal pointer's in order
	it("skips targets already satisfied by a stored BookRoute with matching sectionIds in order", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"] }],
			bookRoutes: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"], pages: "p. 10", method: "Book derivation" }],
		};

		const result = bookRouteTargets(material, TREE);
		assert.deepEqual(result.targets, []);
		assert.equal(result.material.bookRoutes?.length, 1);
	});

	// plan 020 part 3: sectionIds order mismatch or changed sections removes stale route and re-queues target
	it("removes stored BookRoute and re-queues when sectionIds order or set differs from pointer", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview 1" },
				{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview 2" },
			],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"] },
				{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s3", "s4"] },
			],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s2", "s1"], pages: "p. 10", method: "Reordered" },
				{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s3"], pages: "p. 20", method: "Old sections" },
			],
		};

		const result = bookRouteTargets(material, TREE);
		assert.deepEqual(result.targets, [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"] },
			{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s3", "s4"] },
		]);
		assert.deepEqual(result.material.bookRoutes ?? [], []);
	});

	// plan 020 part 3: stored routes for dropped nodes or gone pointers are removed
	it("removes stored routes for dropped nodes, undefined tree, or gone pointers", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referencePointers: [],
			bookRoutes: [
				{ nodeId: "dropped-node", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 1", method: "Dropped" },
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 2", method: "Pointer gone" },
			],
		};

		const pruned = bookRouteTargets(material, TREE);
		assert.deepEqual(pruned.material.bookRoutes ?? [], []);
		assert.deepEqual(bookRouteTargets(material, undefined).material.bookRoutes ?? [], []);
	});

	// plan 020 part 3: a route whose node is merely no longer due (switched to Complete or unticked) is kept but unused
	it("keeps stored routes when a node is merely no longer due", () => {
		const keptRoute = { nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 10", method: "Book derivation" };
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: false, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Now complete" }],
			conflicts: [],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
			bookRoutes: [keptRoute],
		};

		const result = bookRouteTargets(material, TREE);
		assert.deepEqual(result.targets, []);
		assert.deepEqual(result.material.bookRoutes, [keptRoute]);
	});

	// plan 020 part 3: failed routes (error) satisfy the target until pointer sections change
	it("treats failed BookRoutes as satisfying the target until pointer sections change", () => {
		const failed = { nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "", method: "", error: "not covered" };
		const material: CourseMaterial = {
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
			bookRoutes: [failed],
		};

		const samePointer = bookRouteTargets(material, TREE);
		assert.deepEqual(samePointer.targets, []);
		assert.deepEqual(samePointer.material.bookRoutes, [failed]);

		const changedPointer = bookRouteTargets(
			{ ...material, referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"] }] },
			TREE,
		);
		assert.deepEqual(changedPointer.targets, [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1", "s2"] }]);
		assert.deepEqual(changedPointer.material.bookRoutes ?? [], []);
	});
});

describe("clearFailedBookRoutes", () => {
	// plan 020 part 3: Retry on a reference file clears that file's failed routes
	it("clears failed routes for the given reference file while preserving successful routes and other files", () => {
		const material: CourseMaterial = {
			files: [],
			methods: [],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book1.pdf", sectionIds: ["s1"], pages: "", method: "", error: "not covered" },
				{ nodeId: "n2", path: "/course/book1.pdf", sectionIds: ["s2"], pages: "p. 5", method: "Good route" },
				{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s3"], pages: "", method: "", error: "timeout" },
			],
		};

		const cleared = clearFailedBookRoutes(material, "/course/book1.pdf");
		assert.deepEqual(cleared.bookRoutes, [
			{ nodeId: "n2", path: "/course/book1.pdf", sectionIds: ["s2"], pages: "p. 5", method: "Good route" },
			{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s3"], pages: "", method: "", error: "timeout" },
		]);
	});
});

describe("parseBookRoute", () => {
	// plan 020 part 3: parse {"pages":string,"method":string}, method <= BOOK_ROUTE_CAP
	it("parses valid JSON and fenced JSON up to BOOK_ROUTE_CAP", () => {
		const atCap = "x".repeat(BOOK_ROUTE_CAP);
		const parsed = parseBookRoute(`\`\`\`json\n{"pages":"pp. 12-14","method":"${atCap}"}\n\`\`\``);
		assert.deepEqual(parsed, { ok: true, kind: "covered", pages: "pp. 12-14", method: atCap });
	});

	// plan 020 part 3: method longer than BOOK_ROUTE_CAP is a problem
	it("rejects method longer than BOOK_ROUTE_CAP", () => {
		const overCap = "x".repeat(BOOK_ROUTE_CAP + 1);
		const parsed = parseBookRoute(JSON.stringify({ pages: "p. 1", method: overCap }));
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 020 part 3: {"pages":"","method":""} means the sections do not cover the node
	it("recognizes empty pages and method as not-covered", () => {
		const parsed = parseBookRoute(JSON.stringify({ pages: "", method: "" }));
		assert.deepEqual(parsed, { ok: true, kind: "not-covered" });
	});

	// plan 020 part 3: invalid JSON, non-object, missing fields, or empty method with pages
	it("rejects malformed JSON, non-objects, and empty method with non-empty pages", () => {
		for (const bad of [
			"not json",
			"[]",
			"{}",
			JSON.stringify({ pages: 12, method: "x" }),
			JSON.stringify({ pages: "p. 12", method: "   " }),
		]) {
			const parsed = parseBookRoute(bad);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});
});
