import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import v8 from "node:v8";
import { PATHS, ROOT } from "../config.ts";

// The test runner (scripts/run-tests.mjs) gives every run a fresh data folder:
// tests must never write chats, jobs or graphs into the repo's data/, where
// leftovers piled up (2,015 job records, 248 of them "running", which every
// stale-job sweep then walked) and slowed each later run.
describe("test isolation", () => {
	it("runs with LH_DATA_DIR set to a folder outside the repo", () => {
		const dir = process.env.LH_DATA_DIR;
		assert.ok(dir, "LH_DATA_DIR is set (run the tests through npm test or scripts/run-tests.mjs)");
		const relative = path.relative(ROOT, path.resolve(dir));
		assert.ok(relative.startsWith("..") || path.isAbsolute(relative), `LH_DATA_DIR is outside the repo: ${dir}`);
	});

	it("puts the temp folder in the same run folder, so the run's temp files go with it", () => {
		const runDir = path.dirname(path.resolve(process.env.LH_DATA_DIR ?? ""));
		const tmp = path.resolve(os.tmpdir());
		assert.ok(path.basename(runDir).startsWith("lh-test-run-"), `LH_DATA_DIR sits in a run folder: ${runDir}`);
		assert.ok(!path.relative(runDir, tmp).startsWith(".."), `os.tmpdir() (${tmp}) is inside ${runDir}`);
	});

	it("caps each test process's heap at 2 GB, so a runaway allocation crashes in seconds", () => {
		const limit = v8.getHeapStatistics().heap_size_limit;
		assert.ok(limit <= 2.2 * 1024 ** 3, `heap limit ${(limit / 1024 ** 3).toFixed(2)} GB`);
	});

	it("resolves the data paths into that folder", () => {
		assert.equal(PATHS.data, path.resolve(process.env.LH_DATA_DIR ?? ""));
		assert.ok(!PATHS.chats.startsWith(path.join(ROOT, "data")), PATHS.chats);
	});
});
