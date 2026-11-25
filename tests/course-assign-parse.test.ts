import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COURSE_METHOD_CAP, NEW_SECTIONS_CAP, type CourseMaterial } from "../src/core/contracts/course.ts";
import {
	COURSE_ASSIGN_INSTRUCTIONS,
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

	// plan 015 part 2: replace-mode prompt lists per node the previous version's method
	it("includes previousMethods for target nodes in replace mode", () => {
		const prompt = buildAssignmentPrompt({
			path: "/course/regelung-v2.pdf",
			targets: [{ id: "n1", title: "Amplitude margin" }],
			previousMethods: {
				n1: { pages: "S. 10", method: "Old Bode step." },
			},
		});
		assert.ok(prompt.includes("Old Bode step."));
		assert.ok(prompt.includes("S. 10"));
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

	// plan 012 part 3: COURSE_ASSIGN_INSTRUCTIONS gains the confirmed reference branch
	it("includes the owner-confirmed reference branch in COURSE_ASSIGN_INSTRUCTIONS", () => {
		const expected =
			'A published textbook or reference work (ISBN, publisher, edition, numbered chapters) that is not the course\'s own script, slides or lecture notes is a **reference**. For a reference, return {"category":"reference","nodes":[]} at once; do not read it against the plan.';
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes(expected));
	});

	// plan 012 part 3: learner-set category prompt also allows reference
	it("includes reference in buildAssignmentPrompt when category is reference", () => {
		const prompt = buildAssignmentPrompt({
			path: "/course/textbook.pdf",
			targets: [{ id: "n1", title: "Node 1" }],
			category: "reference",
		});
		assert.ok(prompt.includes("This file is a reference; do not decide again."));
	});

	// plan 012 part 3: parseAssignment accepts {"category":"reference","nodes":[]}
	it("accepts a reference result with empty nodes", () => {
		const parsed = parseAssignment(JSON.stringify({ category: "reference", nodes: [] }), TARGETS);
		assert.deepEqual(parsed, { ok: true, value: { category: "reference", nodes: [] } });
	});

	// plan 012 part 3: parseAssignment rejects unknown categories while allowing material, exam, reference
	it("rejects categories other than material, exam, or reference", () => {
		const parsed = parseAssignment(JSON.stringify({ category: "textbook", nodes: [] }), TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 015 part 2: parseAssignment accepts sameAsPreviousVersion (boolean | null) and newSections in replace mode
	it("accepts sameAsPreviousVersion and newSections in replace mode", () => {
		const raw = JSON.stringify({
			category: "material",
			nodes: [
				{ nodeId: "n1", pages: "S. 1", method: "Same route.", sameRouteAsExisting: null, sameAsPreviousVersion: true },
				{ nodeId: "n2", pages: "S. 2", method: "Changed route.", sameRouteAsExisting: null, sameAsPreviousVersion: false },
				{ nodeId: "n3", pages: "S. 3", method: "Newly covered.", sameRouteAsExisting: null, sameAsPreviousVersion: null },
			],
			newSections: [{ title: "Root locus", pages: "S. 40–45" }],
		});
		const parsed = parseAssignment(raw, TARGETS, { replace: true });
		assert.deepEqual(parsed, {
			ok: true,
			value: {
				category: "material",
				nodes: [
					{ nodeId: "n1", pages: "S. 1", method: "Same route.", sameRouteAsExisting: null, sameAsPreviousVersion: true },
					{ nodeId: "n2", pages: "S. 2", method: "Changed route.", sameRouteAsExisting: null, sameAsPreviousVersion: false },
					{ nodeId: "n3", pages: "S. 3", method: "Newly covered.", sameRouteAsExisting: null, sameAsPreviousVersion: null },
				],
				newSections: [{ title: "Root locus", pages: "S. 40–45" }],
			},
		});
	});

	// plan 015 part 2: newSections allows up to NEW_SECTIONS_CAP (15) entries and rejects 16
	it("accepts newSections at NEW_SECTIONS_CAP and rejects one over the cap", () => {
		const makeSections = (count: number) =>
			Array.from({ length: count }, (_, i) => ({ title: `Section ${i + 1}`, pages: `p. ${i + 1}` }));

		const ok = parseAssignment(
			JSON.stringify({ category: "material", nodes: [], newSections: makeSections(NEW_SECTIONS_CAP) }),
			TARGETS,
			{ replace: true },
		);
		assert.equal(ok.ok, true);

		const bad = parseAssignment(
			JSON.stringify({ category: "material", nodes: [], newSections: makeSections(NEW_SECTIONS_CAP + 1) }),
			TARGETS,
			{ replace: true },
		);
		assert.equal(bad.ok, false);
		assert.ok(bad.problems.length > 0);
	});

	// plan 015 part 2: newSections entries require non-empty title and pages
	it("rejects newSections entries with empty or whitespace-only title or pages", () => {
		for (const badSection of [
			{ title: "   ", pages: "p. 1" },
			{ title: "Valid title", pages: "   " },
			{ title: "", pages: "" },
		]) {
			const parsed = parseAssignment(
				JSON.stringify({ category: "material", nodes: [], newSections: [badSection] }),
				TARGETS,
				{ replace: true },
			);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 015 part 2: sameAsPreviousVersion must be boolean or null in replace mode
	it("rejects missing or invalid sameAsPreviousVersion in replace mode", () => {
		for (const invalid of ["true", 1, {}, undefined]) {
			const node: Record<string, unknown> = {
				nodeId: "n1",
				pages: "p. 1",
				method: "Valid.",
				sameRouteAsExisting: null,
			};
			if (invalid !== undefined) node.sameAsPreviousVersion = invalid;
			const parsed = parseAssignment(
				JSON.stringify({ category: "material", nodes: [node], newSections: [] }),
				TARGETS,
				{ replace: true },
			);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 015 part 2: sameAsPreviousVersion and newSections are accepted in replace mode only
	it("rejects sameAsPreviousVersion and newSections outside replace mode", () => {
		const withSame = parseAssignment(
			JSON.stringify({
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 1", method: "Valid.", sameRouteAsExisting: null, sameAsPreviousVersion: true }],
			}),
			TARGETS,
		);
		assert.equal(withSame.ok, false);

		const withSections = parseAssignment(
			JSON.stringify({
				category: "material",
				nodes: [],
				newSections: [{ title: "Extra", pages: "p. 10" }],
			}),
			TARGETS,
		);
		assert.equal(withSections.ok, false);
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

describe("buildAssignmentPrompt replace + existingMethods", () => {
	it("includes previousMethods even when existingMethods are present for the same node", () => {
		const prompt = buildAssignmentPrompt({
			path: "/course/regelung-v2.pdf",
			targets: [{ id: "n1", title: "Amplitude margin" }],
			existingMethods: {
				n1: [{ path: "/course/other.md", method: "Other file route." }],
			},
			previousMethods: {
				n1: { pages: "S. 10", method: "Old Bode step." },
			},
		});
		assert.ok(prompt.includes("Other file route."));
		assert.ok(prompt.includes("Old Bode step."));
		assert.ok(prompt.includes("S. 10"));
	});
});
