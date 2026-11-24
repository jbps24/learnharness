import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial, ReferenceSection } from "../src/core/contracts/course.ts";
import { applyAssignment } from "../src/core/course-assign.ts";

describe("applyAssignment reference cleanup when reader moves file out of reference", () => {
	const sectionsA: ReferenceSection[] = [
		{ id: "s1", title: "Chapter 1", level: 1, startPage: 1, endPage: 10 },
	];
	const sectionsB: ReferenceSection[] = [
		{ id: "s2", title: "Chapter 2", level: 1, startPage: 11, endPage: 20 },
	];

	function materialWithTwoReferences(): CourseMaterial {
		return {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigning",
					category: "reference",
					categoryBy: "reader",
				},
				{
					path: "/course/b.pdf",
					addedAt: "2026-11-24T00:01:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{ path: "/course/a.pdf", from: "outline", sections: sectionsA },
				{ path: "/course/b.pdf", from: "outline", sections: sectionsB },
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/a.pdf", sectionIds: ["s1"] },
				{ nodeId: "n2", path: "/course/a.pdf", sectionIds: ["s1"] },
				{ nodeId: "n1", path: "/course/b.pdf", sectionIds: ["s2"] },
			],
		};
	}

	it("drops the file's referenceIndex and referencePointers when a reader answer moves it to material", () => {
		const next = applyAssignment(materialWithTwoReferences(), "/course/a.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 2", method: "Step 1.", sameRouteAsExisting: null }],
		});

		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.category, "material");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.methods, [{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 2", method: "Step 1." }]);
		assert.deepEqual(next.referenceIndex, [{ path: "/course/b.pdf", from: "outline", sections: sectionsB }]);
		assert.deepEqual(next.referencePointers, [{ nodeId: "n1", path: "/course/b.pdf", sectionIds: ["s2"] }]);
	});

	it("drops the file's referenceIndex and referencePointers when a reader answer moves it to exam", () => {
		const next = applyAssignment(materialWithTwoReferences(), "/course/a.pdf", {
			category: "exam",
			nodes: [{ nodeId: "n1", source: "WS22 A1", pages: "p. 1", pattern: "Compute the transform." }],
		});

		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.category, "exam");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n1", path: "/course/a.pdf", source: "WS22 A1", pages: "p. 1", pattern: "Compute the transform." },
		]);
		assert.deepEqual(next.referenceIndex, [{ path: "/course/b.pdf", from: "outline", sections: sectionsB }]);
		assert.deepEqual(next.referencePointers, [{ nodeId: "n1", path: "/course/b.pdf", sectionIds: ["s2"] }]);
	});

	it("keeps referenceIndex and referencePointers when a learner-locked reference file receives a material or exam reader answer", () => {
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigning",
					category: "reference",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [{ path: "/course/a.pdf", from: "outline", sections: sectionsA }],
			referencePointers: [{ nodeId: "n1", path: "/course/a.pdf", sectionIds: ["s1"] }],
		};

		const afterMaterial = applyAssignment(initial, "/course/a.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "Ignored", sameRouteAsExisting: null }],
		});
		assert.equal(afterMaterial.files[0]?.category, "reference");
		assert.equal(afterMaterial.files[0]?.categoryBy, "learner");
		assert.deepEqual(afterMaterial.referenceIndex, initial.referenceIndex);
		assert.deepEqual(afterMaterial.referencePointers, initial.referencePointers);

		const afterExam = applyAssignment(initial, "/course/a.pdf", {
			category: "exam",
			nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "Ignored" }],
		});
		assert.equal(afterExam.files[0]?.category, "reference");
		assert.equal(afterExam.files[0]?.categoryBy, "learner");
		assert.deepEqual(afterExam.referenceIndex, initial.referenceIndex);
		assert.deepEqual(afterExam.referencePointers, initial.referencePointers);
	});
});
