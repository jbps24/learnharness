#!/usr/bin/env node
// The test runner behind `npm test` (and the ladder's test commands).
//
//   node scripts/run-tests.mjs [test files...]
//
// Runs `tsx --test` over the given files (all of tests/*.test.ts and
// tests/*.test.tsx when none are given) in a fresh run folder, removed
// afterwards: LH_DATA_DIR is <run>/data and the temp folder (TMPDIR, and TMP /
// TEMP for Windows) is <run>/tmp. Without it the tests wrote their chats and
// jobs into the repo's data/, where leftovers piled up run after run and
// slowed every stale-job sweep, and left thousands of temp folders behind
// (tests/test-isolation.test.ts). The exit code is the test run's.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

let files = process.argv.slice(2);
if (files.length === 0) {
	files = fs
		.readdirSync(path.join(root, "tests"))
		.filter((name) => /\.test\.tsx?$/.test(name))
		.sort()
		.map((name) => path.join("tests", name));
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-run-"));
const dataDir = path.join(runDir, "data");
const tmpDir = path.join(runDir, "tmp");
fs.mkdirSync(dataDir);
fs.mkdirSync(tmpDir);
const cleanUp = () => fs.rmSync(runDir, { recursive: true, force: true });

const child = spawn(
	process.execPath,
	[tsx, "--test", "--test-timeout=120000", "--test-force-exit", ...files],
	{ cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "test", LH_DATA_DIR: dataDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir } },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
	cleanUp();
	process.exit(code ?? (signal ? 1 : 0));
});
