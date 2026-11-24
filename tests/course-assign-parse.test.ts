import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COURSE_METHOD_CAP, type CourseMaterial } from "../src/core/contracts/course.ts";
import {
	applyAssignment,
	buildAssignmentPrompt,
	parseAssignment,
} from "../src/core/course-assign.ts";

describe("buildAssignmentPrompt", () => {
	// plan 007 part 3: prompt includes file path, target node id/title/summary/unit info, and existing methods
	it("includes the file path, target nodes with unit context, and existing methods", () => {
		const prompt = buildAssignmentPrompt({
			path: "/course/regelung.pdf",
			targets: [
				{
					id: "fkl-step1",
					title: "Amplitude margin",
					summary: "Read off gain margin at phase crossover",
					unitTitle: "Frequency response",
					unitSource: "Chapter 3",
				},
			],
			existingMethods: {
				"fkl-step1": [{ path: "/course/notes.md", method: "Use Nyquist plot crossing." }],
			},
		});
		assert.ok(prompt.includes("/course/regelung.pdf"));
		assert.ok(prompt.includes("fkl-step1"));
		assert.ok(prompt.includes("Amplitude margin"));
		assert.ok(prompt.includes("Read off gain margin at phase crossover"));
		assert.ok(prompt.includes("Frequency response"));
		assert.ok(prompt.includes("Chapter 3"));
		assert.ok(prompt.includes("/course/notes.md"));
		assert.ok(prompt.includes("Use Nyquist plot crossing."));
	});
});

describe("parseAssignment", () => {
	const TARGETS = ["n1", "n2", "n3"];

	// plan 007 part 3: valid result for two of three target nodes succeeds and omits uncovered node
	it("parses a valid result covering two of three target nodes", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [
				{ nodeId: "n1", pages: "S. 20–27", method: "Step 1, then step 2.", sameRouteAsExisting: null },
				{ nodeId: "n3", pages: "S. 30", method: "Use table 4.", sameRouteAsExisting: true },
			],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.deepEqual(parsed, {
			ok: true,
			value: {
				category: "material",
				nodes: [
					{ nodeId: "n1", pages: "S. 20–27", method: "Step 1, then step 2.", sameRouteAsExisting: null },
					{ nodeId: "n3", pages: "S. 30", method: "Use table 4.", sameRouteAsExisting: true },
				],
			},
		});
	});

	// plan 007 part 3: empty nodes array is valid when file covers none of the target nodes
	it("accepts an empty nodes array when no target nodes are covered", () => {
		const parsed = parseAssignment(JSON.stringify({ category: "material", nodes: [] }), TARGETS);
		assert.deepEqual(parsed, { ok: true, value: { category: "material", nodes: [] } });
	});

	// plan 007 part 3: non-JSON or non-object top-level output returns a problem
	it("rejects non-JSON and non-object top-level output", () => {
		const badJson = parseAssignment("not json", TARGETS);
		assert.equal(badJson.ok, false);
		assert.ok(badJson.problems.length > 0);

		const arrayTop = parseAssignment("[]", TARGETS);
		assert.equal(arrayTop.ok, false);
		assert.ok(arrayTop.problems.length > 0);
	});

	// plan 007 part 3: unknown node id is collected as a problem
	it("rejects an unknown node id", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [{ nodeId: "unknown-id", pages: "p. 1", method: "Some method.", sameRouteAsExisting: null }],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("unknown-id")));
	});

	// plan 007 part 3: duplicate node id is collected as a problem
	it("rejects duplicate node ids", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [
				{ nodeId: "n1", pages: "p. 1", method: "First.", sameRouteAsExisting: null },
				{ nodeId: "n1", pages: "p. 2", method: "Second.", sameRouteAsExisting: null },
			],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("n1")));
	});

	// plan 007 part 3: empty or whitespace-only method is collected as a problem
	it("rejects an empty or whitespace-only method", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "   ", sameRouteAsExisting: null }],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 007 part 3: method at COURSE_METHOD_CAP (1,500 chars) is valid; 1,501 chars is a problem
	it("accepts a method at COURSE_METHOD_CAP and rejects one over the cap", () => {
		const atCap = "x".repeat(COURSE_METHOD_CAP);
		const ok = parseAssignment(
			JSON.stringify({ category: "material", nodes: [{ nodeId: "n1", pages: "p. 1", method: atCap, sameRouteAsExisting: null }] }),
			TARGETS,
		);
		assert.equal(ok.ok, true);

		const overCap = "x".repeat(COURSE_METHOD_CAP + 1);
		const bad = parseAssignment(
			JSON.stringify({ category: "material", nodes: [{ nodeId: "n1", pages: "p. 1", method: overCap, sameRouteAsExisting: null }] }),
			TARGETS,
		);
		assert.equal(bad.ok, false);
		assert.ok(bad.problems.some((p) => p.includes("n1")));
	});

	// plan 007 part 3: sameRouteAsExisting must be boolean or null
	it("rejects sameRouteAsExisting that is not boolean or null", () => {
		for (const invalid of ["true", 1, {}, undefined]) {
			const raw = JSON.stringify({
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 1", method: "Valid.", ...(invalid !== undefined ? { sameRouteAsExisting: invalid } : {}) }],
			});
			const parsed = parseAssignment(raw, TARGETS);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 007 part 3: multiple problems across entries are all collected
	it("collects all problems across entries", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [
				{ nodeId: "bogus", pages: "p. 1", method: "", sameRouteAsExisting: "yes" },
				{ nodeId: "n2", pages: "p. 2", method: "x".repeat(COURSE_METHOD_CAP + 1), sameRouteAsExisting: false },
			],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length >= 3);
	});
});

describe("applyAssignment", () => {
	function baseMaterial(): CourseMaterial {
		return {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [],
			conflicts: [],
		};
	}

	// plan 007 part 3: valid result for two of three targets stores two methods and sets file status to assigned
	it("stores methods for covered nodes and sets file status to assigned", () => {
		const next = applyAssignment(baseMaterial(), "/course/a.pdf", {
			category: "material",
			nodes: [
				{ nodeId: "n1", pages: "S. 20–27", method: "Method 1", sameRouteAsExisting: null },
				{ nodeId: "n2", pages: "S. 28", method: "Method 2", sameRouteAsExisting: null },
			],
		});
		assert.equal(next.files[0]?.status, "assigned");
		assert.deepEqual(next.methods, [
			{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 20–27", method: "Method 1" },
			{ nodeId: "n2", path: "/course/a.pdf", pages: "S. 28", method: "Method 2" },
		]);
		assert.deepEqual(next.conflicts, []);
	});

	// plan 007 part 3: replaces existing methods for this file on target nodes while preserving other files and non-target nodes
	it("replaces this file's methods for target nodes without touching other files or non-target nodes", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "tutor", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Old A on n1" },
				{ nodeId: "n2", path: "/course/a.pdf", pages: "p. 2", method: "Keep A on n2" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 5", method: "Keep B on n1" },
			],
			conflicts: [],
		};
		const next = applyAssignment(
			initial,
			"/course/a.pdf",
			{ category: "material", nodes: [{ nodeId: "n1", pages: "p. 10", method: "New A on n1", sameRouteAsExisting: true }] },
			["n1"],
		);
		assert.deepEqual(next.methods, [
			{ nodeId: "n2", path: "/course/a.pdf", pages: "p. 2", method: "Keep A on n2" },
			{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 5", method: "Keep B on n1" },
			{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 10", method: "New A on n1" },
		]);
	});

	// plan 007 part 3: sameRouteAsExisting false creates a NodeConflict with existing path(s) first, then this path
	it("creates a conflict with existing path(s) first when sameRouteAsExisting is false", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Route A" }],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/b.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 3", method: "Route B", sameRouteAsExisting: false }],
		});
		assert.deepEqual(next.conflicts, [
			{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] },
		]);
	});

	// plan 007 part 3: sameRouteAsExisting false appends to an existing NodeConflict without duplicating paths
	it("appends to an existing conflict without duplicating paths", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/c.pdf", addedAt: "2026-11-22T00:02:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Route A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 2", method: "Route B" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
		};
		const next = applyAssignment(initial, "/course/c.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 4", method: "Route C", sameRouteAsExisting: false }],
		});
		assert.deepEqual(next.conflicts, [
			{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf", "/course/c.pdf"] },
		]);
	});

	// plan 007 part 3: a target node the file no longer covers loses this file's method; non-target nodes keep theirs
	it("removes this file's old method on a target node omitted from the result", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" }],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Old n1" },
				{ nodeId: "n2", path: "/course/a.pdf", pages: "p. 2", method: "Old n2" },
				{ nodeId: "n3", path: "/course/a.pdf", pages: "p. 3", method: "Old n3" },
			],
			conflicts: [],
		};
		const next = applyAssignment(
			initial,
			"/course/a.pdf",
			{ category: "material", nodes: [{ nodeId: "n1", pages: "p. 9", method: "New n1", sameRouteAsExisting: null }] },
			["n1", "n2"],
		);
		assert.deepEqual(
			next.methods.map((m) => `${m.nodeId}:${m.method}`).sort(),
			["n1:New n1", "n3:Old n3"],
		);
	});

	// plan 007 part 3: sameRouteAsExisting true or null leaves conflicts alone
	it("leaves existing conflicts alone when sameRouteAsExisting is true or null", () => {
		for (const same of [true, null]) {
			const initial: CourseMaterial = {
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/c.pdf", addedAt: "2026-11-22T00:02:00.000Z", via: "learner", binding: true, status: "assigning" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Route A" },
					{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 2", method: "Route B" },
				],
				conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
			};
			const next = applyAssignment(initial, "/course/c.pdf", {
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 2", method: "Same route", sameRouteAsExisting: same }],
			});
			assert.deepEqual(next.conflicts, [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }]);
		}
	});

	// plan 007 part 3: clears any previous error on the file when setting status to assigned
	it("clears previous error on the file when assigned", () => {
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "Assignment was interrupted.",
				},
			],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/a.pdf", { category: "material", nodes: [] });
		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.error, undefined);
	});
});
