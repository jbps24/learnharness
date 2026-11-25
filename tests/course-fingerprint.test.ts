import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { detectCourseFileChanges, readFileFingerprint } from "../src/server/course-fingerprint.ts";
import { mergeDetectedCourseFileChanges } from "../src/server/course-fingerprint.ts";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-fp-"));

after(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function baseMaterial(filePath: string, extra?: Partial<CourseMaterial["files"][number]>): CourseMaterial {
	return {
		files: [
			{
				path: filePath,
				addedAt: "2026-11-24T00:00:00.000Z",
				via: "learner",
				binding: true,
				status: "assigned",
				...extra,
			},
		],
		methods: [],
		conflicts: [],
	};
}

describe("course-fingerprint", () => {
	// plan 015 part 2: fingerprint baseline without flag
	it("stores a fingerprint baseline without setting changedOnDisk", async () => {
		const filePath = path.join(TMP_DIR, "baseline.md");
		fs.writeFileSync(filePath, "# Chapter 1\nMethod A\n", "utf8");

		const res = await detectCourseFileChanges(baseMaterial(filePath));
		assert.equal(res.changed, false);
		const file = res.material.files[0];
		assert.ok(file?.fingerprint);
		assert.equal(typeof file.fingerprint.size, "number");
		assert.equal(typeof file.fingerprint.mtimeMs, "number");
		assert.equal(typeof file.fingerprint.sha256, "string");
		assert.ok(file.fingerprint.sha256.length > 0);
		assert.equal(Boolean(file.changedOnDisk), false);
	});

	// plan 015 part 2: flag on content change
	it("sets changedOnDisk when file content changes", async () => {
		const filePath = path.join(TMP_DIR, "changed.md");
		fs.writeFileSync(filePath, "version 1", "utf8");
		const fp = await readFileFingerprint(filePath);
		assert.ok(fp);

		fs.writeFileSync(filePath, "version 2 with new content", "utf8");
		const res = await detectCourseFileChanges(baseMaterial(filePath, { fingerprint: fp }));
		assert.equal(res.changed, true);
		assert.equal(res.material.files[0]?.changedOnDisk, true);
	});

	// plan 015 part 2: no flag on mtime-only change with the same hash
	it("does not set changedOnDisk when mtime changes but content hash is unchanged", async () => {
		const filePath = path.join(TMP_DIR, "mtime-only.md");
		fs.writeFileSync(filePath, "identical content", "utf8");
		const fp = await readFileFingerprint(filePath);
		assert.ok(fp);

		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(filePath, future, future);
		const res = await detectCourseFileChanges(baseMaterial(filePath, { fingerprint: fp }));
		assert.equal(res.changed, false);
		assert.equal(Boolean(res.material.files[0]?.changedOnDisk), false);
	});

	// plan 015 part 2: missing file not flagged
	it("does not flag a missing file on disk", async () => {
		const missingPath = path.join(TMP_DIR, "does-not-exist.md");
		const res = await detectCourseFileChanges(
			baseMaterial(missingPath, {
				fingerprint: { size: 10, mtimeMs: 1_000, sha256: "abc" },
			}),
		);
		assert.equal(res.changed, false);
		assert.equal(Boolean(res.material.files[0]?.changedOnDisk), false);
	});
});

describe("course-fingerprint edge cases", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-fp-extra-"));

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function materialFor(filePath: string, extra?: Partial<CourseMaterial["files"][number]>): CourseMaterial {
		return {
			files: [
				{
					path: filePath,
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					...extra,
				},
			],
			methods: [],
			conflicts: [],
		};
	}

	it("flags changed content when size is unchanged and mtime differs", async () => {
		const filePath = path.join(dir, "same-size.md");
		fs.writeFileSync(filePath, "version 1", "utf8");
		const fp = await readFileFingerprint(filePath);
		assert.ok(fp);

		fs.writeFileSync(filePath, "version 2", "utf8");
		assert.equal(fs.statSync(filePath).size, fp.size);
		const later = new Date(fp.mtimeMs + 5_000);
		fs.utimesSync(filePath, later, later);

		const res = await detectCourseFileChanges(materialFor(filePath, { fingerprint: fp }));
		assert.equal(res.changed, true);
		assert.equal(res.material.files[0]?.changedOnDisk, true);
	});

	it("does not re-hash or report changed again when changedOnDisk is already set", async () => {
		const filePath = path.join(dir, "already-flagged.md");
		fs.writeFileSync(filePath, "version 1", "utf8");
		const fp = await readFileFingerprint(filePath);
		assert.ok(fp);

		fs.writeFileSync(filePath, "version 2 changed", "utf8");
		const first = await detectCourseFileChanges(materialFor(filePath, { fingerprint: fp }));
		assert.equal(first.changed, true);
		assert.equal(first.material.files[0]?.changedOnDisk, true);

		const second = await detectCourseFileChanges(first.material);
		assert.equal(second.changed, false);
		assert.equal(second.material, first.material);
	});
});

describe("mergeDetectedCourseFileChanges", () => {
	const fpOld = { size: 10, mtimeMs: 1_000, sha256: "old-hash" };
	const fpNew = { size: 12, mtimeMs: 2_000, sha256: "new-hash" };

	it("applies changedOnDisk without clobbering concurrent methods, removals, or replacements", () => {
		const before: CourseMaterial = {
			files: [
				{ path: "/course/unchanged-meta.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
				{ path: "/course/removed.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
				{ path: "/course/replaced-v1.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
			],
			methods: [],
			conflicts: [],
		};
		const after: CourseMaterial = {
			...before,
			files: [
				{ ...before.files[0]!, changedOnDisk: true },
				{ ...before.files[1]!, changedOnDisk: true },
				{ ...before.files[2]!, changedOnDisk: true },
			],
		};
		const fresh: CourseMaterial = {
			files: [
				{ path: "/course/unchanged-meta.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: false, status: "assigned", fingerprint: fpOld },
				{ path: "/course/replaced-v2.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [{ nodeId: "n1", path: "/course/unchanged-meta.md", pages: "p. 1", method: "Concurrent method" }],
			conflicts: [{ nodeId: "n1", paths: ["/course/unchanged-meta.md", "/course/other.md"] }],
		};

		const merged = mergeDetectedCourseFileChanges(fresh, before, after);
		assert.equal(merged.changed, true);
		assert.equal(merged.material.files.length, 2);
		assert.equal(merged.material.files[0]?.changedOnDisk, true);
		assert.equal(merged.material.files[0]?.binding, false);
		assert.equal(merged.material.files[1]?.path, "/course/replaced-v2.md");
		assert.deepEqual(merged.material.methods, fresh.methods);
		assert.deepEqual(merged.material.conflicts, fresh.conflicts);
	});

	it("skips files that transitioned to assigning, updated fingerprint, or already flagged", () => {
		const before: CourseMaterial = {
			files: [
				{ path: "/course/now-assigning.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
				{ path: "/course/new-fp.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
				{ path: "/course/already-flagged.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld },
			],
			methods: [],
			conflicts: [],
		};
		const after: CourseMaterial = {
			...before,
			files: before.files.map((f) => ({ ...f, changedOnDisk: true })),
		};
		const fresh: CourseMaterial = {
			files: [
				{ path: "/course/now-assigning.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning", fingerprint: fpOld },
				{ path: "/course/new-fp.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpNew },
				{ path: "/course/already-flagged.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint: fpOld, changedOnDisk: true },
			],
			methods: [],
			conflicts: [],
		};

		const merged = mergeDetectedCourseFileChanges(fresh, before, after);
		assert.equal(merged.changed, false);
		assert.equal(merged.material, fresh);
	});

	it("applies refreshed fingerprint without marking changed", () => {
		const before: CourseMaterial = {
			files: [{ path: "/course/baseline.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		};
		const after: CourseMaterial = {
			...before,
			files: [{ ...before.files[0]!, fingerprint: fpNew }],
		};
		const fresh: CourseMaterial = {
			files: [{ path: "/course/baseline.md", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/baseline.md", method: "Route A" }],
			conflicts: [],
		};

		const merged = mergeDetectedCourseFileChanges(fresh, before, after);
		assert.equal(merged.changed, false);
		assert.notEqual(merged.material, fresh);
		assert.deepEqual(merged.material.files[0]?.fingerprint, fpNew);
		assert.equal(Boolean(merged.material.files[0]?.changedOnDisk), false);
		assert.deepEqual(merged.material.methods, fresh.methods);
	});
});
