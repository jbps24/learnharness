import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { classifyUpdate, startReplacement } from "../src/core/course-replace.ts";

describe("startReplacement", () => {
	const NOW = "2026-11-24T12:00:00.000Z";

	// plan 015 part 1: snapshots old file's binding methods into previous; replaces file entry with new path, carried-over fields, status pending, no error, no changedOnDisk, no fingerprint
	it("snapshots old binding methods into update.previous and carries over file fields while resetting status and transient flags", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/v1.pdf",
					addedAt: "2026-11-20T09:00:00.000Z",
					via: "learner",
					binding: false,
					status: "failed",
					error: "previous read error",
					category: "material",
					categoryBy: "learner",
					fingerprint: { size: 1024, mtimeMs: 1700000000000, sha256: "oldhash" },
					changedOnDisk: true,
				},
				{
					path: "/course/other.pdf",
					addedAt: "2026-11-20T09:05:00.000Z",
					via: "tutor",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/v1.pdf", pages: "S. 10-14", method: "Bode method" },
				{ nodeId: "n2", path: "/course/v1.pdf", method: "Nyquist without pages" },
				{ nodeId: "n1", path: "/course/other.pdf", pages: "S. 1-3", method: "Other method" },
			],
			conflicts: [],
		};

		const snapshot = structuredClone(material);
		const result = startReplacement(material, "/course/v1.pdf", "/course/v2.pdf", NOW);

		assert.deepEqual(material, snapshot);

		const replaced = result.files.find((f) => f.path === "/course/v2.pdf");
		assert.ok(replaced);
		assert.equal(replaced.path, "/course/v2.pdf");
		assert.equal(replaced.addedAt, "2026-11-20T09:00:00.000Z");
		assert.equal(replaced.via, "learner");
		assert.equal(replaced.binding, false);
		assert.equal(replaced.status, "pending");
		assert.equal(replaced.category, "material");
		assert.equal(replaced.categoryBy, "learner");
		assert.equal("error" in replaced, false);
		assert.equal("changedOnDisk" in replaced, false);
		assert.equal("fingerprint" in replaced, false);
		assert.deepEqual(replaced.update, {
			at: NOW,
			fromPath: "/course/v1.pdf",
			previous: [
				{ nodeId: "n1", pages: "S. 10-14", method: "Bode method" },
				{ nodeId: "n2", method: "Nyquist without pages" },
			],
			revisited: [],
			planAsked: false,
		});
		assert.equal("nodes" in replaced.update!, false);
		assert.equal("newSections" in replaced.update!, false);

		assert.equal(result.files.some((f) => f.path === "/course/v1.pdf"), false);
		assert.deepEqual(result.files.find((f) => f.path === "/course/other.pdf"), material.files[1]);
	});

	// plan 015 part 1: removes the old path's methods, exam patterns, reference index and pointers while leaving other files untouched
	it("removes old path entries from methods, examPatterns, referenceIndex, and referencePointers", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/v1.pdf",
					addedAt: "2026-11-20T09:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
				{
					path: "/course/keep.pdf",
					addedAt: "2026-11-20T09:01:00.000Z",
					via: "tutor",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/v1.pdf", method: "Old method" },
				{ nodeId: "n1", path: "/course/keep.pdf", method: "Keep method" },
			],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/v1.pdf", source: "WS22", pattern: "Old pattern" },
				{ nodeId: "n1", path: "/course/keep.pdf", source: "SS23", pattern: "Keep pattern" },
			],
			referenceIndex: [
				{
					path: "/course/v1.pdf",
					from: "outline",
					sections: [{ id: "s1", title: "Old", level: 1, startPage: 1, endPage: 4 }],
				},
				{
					path: "/course/keep.pdf",
					from: "headings",
					sections: [{ id: "s2", title: "Keep", level: 1, startPage: 1, endPage: 8 }],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/v1.pdf", sectionIds: ["s1"] },
				{ nodeId: "n1", path: "/course/keep.pdf", sectionIds: ["s2"] },
			],
		};

		const result = startReplacement(material, "/course/v1.pdf", "/course/v2.pdf", NOW);

		assert.deepEqual(result.methods, [{ nodeId: "n1", path: "/course/keep.pdf", method: "Keep method" }]);
		assert.deepEqual(result.examPatterns, [{ nodeId: "n1", path: "/course/keep.pdf", source: "SS23", pattern: "Keep pattern" }]);
		assert.deepEqual(result.referenceIndex, [
			{
				path: "/course/keep.pdf",
				from: "headings",
				sections: [{ id: "s2", title: "Keep", level: 1, startPage: 1, endPage: 8 }],
			},
		]);
		assert.deepEqual(result.referencePointers, [{ nodeId: "n1", path: "/course/keep.pdf", sectionIds: ["s2"] }]);
	});

	// plan 015 part 1: in conflicts swaps the old path for the new one, keeping chosen when it was the old path
	it("swaps oldPath for newPath in conflicts and updates chosen only when chosen was oldPath", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/v1.pdf",
					addedAt: "2026-11-20T09:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
				{
					path: "/course/b.pdf",
					addedAt: "2026-11-20T09:01:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/c.pdf",
					addedAt: "2026-11-20T09:02:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/v1.pdf", "/course/b.pdf"], chosen: "/course/v1.pdf" },
				{ nodeId: "n2", paths: ["/course/b.pdf", "/course/v1.pdf"], chosen: "/course/b.pdf" },
				{ nodeId: "n3", paths: ["/course/v1.pdf", "/course/c.pdf"] },
				{ nodeId: "n4", paths: ["/course/b.pdf", "/course/c.pdf"], chosen: "/course/c.pdf" },
			],
		};

		const result = startReplacement(material, "/course/v1.pdf", "/course/v2.pdf", NOW);

		assert.deepEqual(result.conflicts, [
			{ nodeId: "n1", paths: ["/course/v2.pdf", "/course/b.pdf"], chosen: "/course/v2.pdf" },
			{ nodeId: "n2", paths: ["/course/b.pdf", "/course/v2.pdf"], chosen: "/course/b.pdf" },
			{ nodeId: "n3", paths: ["/course/v2.pdf", "/course/c.pdf"] },
			{ nodeId: "n4", paths: ["/course/b.pdf", "/course/c.pdf"], chosen: "/course/c.pdf" },
		]);
		assert.equal("chosen" in result.conflicts[2]!, false);
	});

	// plan 015 part 1: update is set only for category material (exam and reference files get no update)
	it("does not set update when replacing an exam or reference file", () => {
		const examMaterial: CourseMaterial = {
			files: [
				{
					path: "/course/exam-v1.pdf",
					addedAt: "2026-11-20T09:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
			examPatterns: [{ nodeId: "n1", path: "/course/exam-v1.pdf", source: "WS23", pattern: "P1" }],
		};

		const examResult = startReplacement(examMaterial, "/course/exam-v1.pdf", "/course/exam-v2.pdf", NOW);
		assert.equal(examResult.files[0]?.path, "/course/exam-v2.pdf");
		assert.equal(examResult.files[0]?.status, "pending");
		assert.equal(examResult.files[0]?.category, "exam");
		assert.equal("update" in examResult.files[0]!, false);
		assert.deepEqual(examResult.examPatterns, []);

		const refMaterial: CourseMaterial = {
			files: [
				{
					path: "/course/ref-v1.pdf",
					addedAt: "2026-11-20T09:00:00.000Z",
					via: "tutor",
					binding: true,
					status: "assigned",
					category: "reference",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/ref-v1.pdf",
					from: "outline",
					sections: [{ id: "s1", title: "Intro", level: 1, startPage: 1, endPage: 5 }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/ref-v1.pdf", sectionIds: ["s1"] }],
		};

		const refResult = startReplacement(refMaterial, "/course/ref-v1.pdf", "/course/ref-v2.pdf", NOW);
		assert.equal(refResult.files[0]?.path, "/course/ref-v2.pdf");
		assert.equal(refResult.files[0]?.status, "pending");
		assert.equal(refResult.files[0]?.category, "reference");
		assert.equal("update" in refResult.files[0]!, false);
		assert.deepEqual(refResult.referenceIndex, []);
		assert.deepEqual(refResult.referencePointers, []);
	});

});

describe("classifyUpdate", () => {
	// plan 015 part 1: classifyUpdate classifies same, changed, new, and dropped nodes
	it("classifies same, changed, new, and dropped nodes from previous, newMethods, and sameAsPrevious", () => {
		const previous = [
			{ nodeId: "n-dropped", pages: "p. 1", method: "Removed" },
			{ nodeId: "n-same", pages: "p. 2", method: "Unchanged" },
			{ nodeId: "n-changed", pages: "p. 3", method: "Old route" },
		];
		const newMethods = [
			{ nodeId: "n-same", pages: "p. 2", method: "Unchanged" },
			{ nodeId: "n-changed", pages: "p. 5", method: "New route" },
			{ nodeId: "n-new", pages: "p. 8", method: "Added route" },
		];
		const sameAsPrevious: Record<string, boolean> = {
			"n-same": true,
			"n-changed": false,
		};

		const result = classifyUpdate(previous, newMethods, sameAsPrevious) ?? [];
		const byNode = Object.fromEntries(result.map((entry) => [entry.nodeId, entry.kind]));

		assert.equal(result.length, 4);
		assert.deepEqual(byNode, {
			"n-dropped": "dropped",
			"n-same": "same",
			"n-changed": "changed",
			"n-new": "new",
		});
	});

	// plan 015 part 1: classifyUpdate handles empty inputs, all-dropped, and all-new
	it("returns empty array when both previous and newMethods are empty, and handles all-dropped and all-new sets", () => {
		assert.deepEqual(classifyUpdate([], [], {}), []);

		const allDropped = classifyUpdate(
			[{ nodeId: "n1", method: "M1" }, { nodeId: "n2", method: "M2" }],
			[],
			{},
		);
		assert.deepEqual(allDropped, [
			{ nodeId: "n1", kind: "dropped" },
			{ nodeId: "n2", kind: "dropped" },
		]);

		const allNew = classifyUpdate(
			[],
			[{ nodeId: "n3", method: "M3" }, { nodeId: "n4", method: "M4" }],
			{},
		);
		assert.deepEqual(allNew, [
			{ nodeId: "n3", kind: "new" },
			{ nodeId: "n4", kind: "new" },
		]);
	});
});
