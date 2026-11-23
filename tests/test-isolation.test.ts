import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
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

	it("resolves the data paths into that folder", () => {
		assert.equal(PATHS.data, path.resolve(process.env.LH_DATA_DIR ?? ""));
		assert.ok(!PATHS.chats.startsWith(path.join(ROOT, "data")), PATHS.chats);
	});
});
