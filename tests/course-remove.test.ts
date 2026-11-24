import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { courseFilesUsed, mergeCourseFiles } from "../src/core/course-files.ts";
import { removeCourseFile } from "../src/core/course-remove.ts";
import { newUserMessage } from "../src/core/native-messages.ts";

describe("removeCourseFile", () => {
	// plan 014 part 1: cleanup of each stored kind (files, methods, conflicts, examPatterns, referenceIndex, referencePointers, propositionMethods, propositionExamPatterns) while leaving unrelated files untouched
	it("removes all entries for the path across every stored kind and leaves unrelated files untouched", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/remove.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/keep.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "tutor", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/remove.pdf", pages: "p. 1", method: "Removed method" },
				{ nodeId: "n1", path: "/course/keep.pdf", pages: "p. 2", method: "Kept method" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/remove.pdf", "/course/keep.pdf"], chosen: "/course/remove.pdf" },
			],
			examPatterns: [
				{ nodeId: "n2", path: "/course/remove.pdf", source: "WS22 A1", pattern: "Removed pattern" },
				{ nodeId: "n2", path: "/course/keep.pdf", source: "SS23 A2", pattern: "Kept pattern" },
			],
			referenceIndex: [
				{
					path: "/course/remove.pdf",
					from: "outline",
					sections: [{ id: "s1", title: "Sec 1", level: 1, startPage: 1, endPage: 5 }],
				},
				{
					path: "/course/keep.pdf",
					from: "contents",
					sections: [{ id: "s2", title: "Sec 2", level: 1, startPage: 1, endPage: 10 }],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/remove.pdf", sectionIds: ["s1"] },
				{ nodeId: "n1", path: "/course/keep.pdf", sectionIds: ["s2"] },
			],
			propositionMethods: [
				{ propositionId: "p1", lessonId: "l1", nodeId: "n1", path: "/course/remove.pdf", method: "Prop removed" },
				{ propositionId: "p1", lessonId: "l1", nodeId: "n1", path: "/course/keep.pdf", method: "Prop kept" },
			],
			propositionExamPatterns: [
				{ propositionId: "p2", lessonId: "l1", nodeId: "n2", path: "/course/remove.pdf", source: "WS22 A1", pattern: "Prop exam removed" },
				{ propositionId: "p2", lessonId: "l1", nodeId: "n2", path: "/course/keep.pdf", source: "SS23 A2", pattern: "Prop exam kept" },
			],
		};

		const snapshot = structuredClone(material);
		const result = removeCourseFile(material, "/course/remove.pdf");

		assert.deepEqual(material, snapshot);
		assert.deepEqual(result, {
			files: [{ path: "/course/keep.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "tutor", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/keep.pdf", pages: "p. 2", method: "Kept method" }],
			conflicts: [],
			examPatterns: [{ nodeId: "n2", path: "/course/keep.pdf", source: "SS23 A2", pattern: "Kept pattern" }],
			referenceIndex: [
				{
					path: "/course/keep.pdf",
					from: "contents",
					sections: [{ id: "s2", title: "Sec 2", level: 1, startPage: 1, endPage: 10 }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/keep.pdf", sectionIds: ["s2"] }],
			propositionMethods: [{ propositionId: "p1", lessonId: "l1", nodeId: "n1", path: "/course/keep.pdf", method: "Prop kept" }],
			propositionExamPatterns: [
				{ propositionId: "p2", lessonId: "l1", nodeId: "n2", path: "/course/keep.pdf", source: "SS23 A2", pattern: "Prop exam kept" },
			],
		});
	});

	// plan 014 part 1: conflict drop at < 2 paths and chosen cleared when chosen is the removed path
	it("drops a 2-way conflict and clears chosen on a 3-way conflict when the removed path was chosen", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/c.pdf", addedAt: "2026-11-22T00:02:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/b.pdf" },
				{ nodeId: "n2", paths: ["/course/a.pdf", "/course/b.pdf", "/course/c.pdf"], chosen: "/course/a.pdf" },
			],
		};

		const result = removeCourseFile(material, "/course/a.pdf");

		assert.deepEqual(result.conflicts, [
			{ nodeId: "n2", paths: ["/course/b.pdf", "/course/c.pdf"] },
		]);
		assert.equal("chosen" in result.conflicts[0]!, false);
	});

	// plan 014 part 1: conflict chosen is preserved when a different path is removed from a 3-way conflict
	it("preserves chosen on a surviving conflict when a non-chosen path is removed", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/c.pdf", addedAt: "2026-11-22T00:02:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf", "/course/c.pdf"], chosen: "/course/b.pdf" },
			],
		};

		const result = removeCourseFile(material, "/course/a.pdf");

		assert.deepEqual(result.conflicts, [
			{ nodeId: "n1", paths: ["/course/b.pdf", "/course/c.pdf"], chosen: "/course/b.pdf" },
		]);
	});

	// plan 014 part 1: removeCourseFile changes nothing else when optional snapshot/index fields are absent
	it("keeps optional fields absent when they were not present", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		};

		const result = removeCourseFile(material, "/course/a.pdf");

		assert.deepEqual(result, { files: [], methods: [], conflicts: [] });
		assert.equal("examPatterns" in result, false);
		assert.equal("referenceIndex" in result, false);
		assert.equal("referencePointers" in result, false);
		assert.equal("propositionMethods" in result, false);
		assert.equal("propositionExamPatterns" in result, false);
	});

	// plan 014 part 1: removing an unknown path leaves material unchanged
	it("leaves material unchanged when the path is not present", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", method: "Method A" }],
			conflicts: [],
		};

		const result = removeCourseFile(material, "/course/missing.pdf");
		assert.deepEqual(result, material);
	});

	// plan 014 owner decision 1: a removed file joins again as a new pending file only when a later turn uses it
	it("allows a later turn using the removed path to re-add it as a new pending file", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: false, status: "assigned" },
			],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", method: "Old" }],
			conflicts: [],
		};

		const afterRemove = removeCourseFile(initial, "/course/a.pdf");
		assert.deepEqual(afterRemove.files, []);

		const laterNow = "2026-11-24T12:00:00.000Z";
		const merged = mergeCourseFiles(
			afterRemove,
			courseFilesUsed([newUserMessage("Please check `/course/a.pdf` again")]),
			laterNow,
		);

		assert.deepEqual(merged.added, ["/course/a.pdf"]);
		assert.deepEqual(merged.material.files, [
			{
				path: "/course/a.pdf",
				addedAt: laterNow,
				via: "learner",
				binding: true,
				status: "pending",
			},
		]);
	});
});
