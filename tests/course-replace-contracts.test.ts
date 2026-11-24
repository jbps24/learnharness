import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	NEW_SECTIONS_CAP,
	type CourseFile,
	type CourseMaterial,
	type CourseUpdate,
} from "../src/core/contracts/course.ts";

describe("course-replace contracts", () => {
	// plan 015 part 1: NEW_SECTIONS_CAP is 15 and CourseFile supports fingerprint, changedOnDisk, and update
	it("exports NEW_SECTIONS_CAP = 15 and allows CourseFile with fingerprint, changedOnDisk, and update", () => {
		assert.equal(NEW_SECTIONS_CAP, 15);

		const file: CourseFile = {
			path: "/course/notes-v2.pdf",
			addedAt: "2026-11-24T10:00:00.000Z",
			via: "learner",
			binding: true,
			status: "pending",
			category: "material",
			categoryBy: "reader",
			fingerprint: { size: 4096, mtimeMs: 1700000000000, sha256: "deadbeef" },
			changedOnDisk: true,
			update: {
				at: "2026-11-24T12:00:00.000Z",
				fromPath: "/course/notes-v1.pdf",
				previous: [{ nodeId: "n1", pages: "S. 1-5", method: "Old method" }],
				revisited: [],
				planAsked: false,
			},
		};

		assert.equal(file.fingerprint?.sha256, "deadbeef");
		assert.equal(file.changedOnDisk, true);
		assert.equal(file.update?.fromPath, "/course/notes-v1.pdf");
	});

	// plan 015 part 1: CourseUpdate nodes and newSections are absent until the read finishes, then populated
	it("represents CourseUpdate without nodes/newSections before read finishes and with them after", () => {
		const pendingUpdate: CourseUpdate = {
			at: "2026-11-24T12:00:00.000Z",
			fromPath: "/course/v1.pdf",
			previous: [{ nodeId: "n1", method: "Method A" }],
			revisited: [],
			planAsked: false,
		};
		assert.equal("nodes" in pendingUpdate, false);
		assert.equal("newSections" in pendingUpdate, false);

		const finishedUpdate: CourseUpdate = {
			...pendingUpdate,
			nodes: [
				{ nodeId: "n1", kind: "changed" },
				{ nodeId: "n2", kind: "new" },
			],
			newSections: [{ title: "State Space", pages: "pp. 40-52" }],
			revisited: ["n1"],
			planAsked: true,
		};
		assert.equal(finishedUpdate.nodes?.length, 2);
		assert.equal(finishedUpdate.newSections?.[0]?.title, "State Space");
	});

	// plan 015 part 1: a record without the new fields round-trips unchanged
	it("round-trips a CourseMaterial record without the new fields unchanged", () => {
		const legacy: CourseMaterial = {
			files: [
				{
					path: "/course/legacy.pdf",
					addedAt: "2026-11-20T00:00:00.000Z",
					via: "tutor",
					binding: true,
					status: "assigned",
					category: "material",
					categoryBy: "reader",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/legacy.pdf", pages: "p. 3", method: "Legacy method" }],
			conflicts: [],
		};

		const roundTripped = JSON.parse(JSON.stringify(legacy)) as CourseMaterial;
		assert.deepEqual(roundTripped, legacy);
		assert.equal("fingerprint" in roundTripped.files[0]!, false);
		assert.equal("changedOnDisk" in roundTripped.files[0]!, false);
		assert.equal("update" in roundTripped.files[0]!, false);
	});
});
