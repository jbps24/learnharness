import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

describe("course-assign jobs integration", () => {
	let dataDir = "";
	let abortJob: typeof import("../src/server/jobs.ts").abortJob;
	let recoverStaleJobs: typeof import("../src/server/jobs.ts").recoverStaleJobs;
	let stores: typeof import("../src/server/stores.ts").stores;
	let subscribe: typeof import("../src/core/events.ts").subscribe;
	let registerJobAbort: typeof import("../src/agent/subagents/aborts.ts").registerJobAbort;
	let unregisterJobAbort: typeof import("../src/agent/subagents/aborts.ts").unregisterJobAbort;

	before(async () => {
		dataDir = mkdtempSync(path.join(tmpdir(), "lh-course-assign-jobs-"));
		process.env.LH_DATA_DIR = dataDir;
		({ abortJob, recoverStaleJobs } = await import("../src/server/jobs.ts"));
		({ stores } = await import("../src/server/stores.ts"));
		({ subscribe } = await import("../src/core/events.ts"));
		({ registerJobAbort, unregisterJobAbort } = await import("../src/agent/subagents/aborts.ts"));
	});

	after(() => {
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	});

	it("aborts a running course-assign job without queueing a lesson steer", () => {
		const chat = stores.chatStore.createChat("Course Abort Test");
		const job = stores.jobStore.createJob({
			kind: "pdf",
			chatId: chat.id,
			toolCallId: "course-assign:1:/course/a.pdf",
			activity: "assigning /course/a.pdf",
			input: { path: "/course/a.pdf", nodeIds: ["n1"] },
		});
		const controller = new AbortController();
		registerJobAbort(job.id, controller);

		try {
			const outcome = abortJob(job.id);
			assert.deepEqual(outcome, { ok: true });
			assert.equal(controller.signal.aborted, true);

			const updated = stores.jobStore.getJob(job.id);
			assert.equal(updated?.status, "error");
			assert.equal(updated?.error, "Assignment was interrupted.");
			assert.equal(updated?.activity, "aborted");
			assert.equal(updated?.delivery, undefined);
		} finally {
			unregisterJobAbort(job.id);
		}
	});

	it("recovers orphaned course-assign jobs and fails their assigning file", () => {
		const chat = stores.chatStore.createChat("Course Recovery Test");
		stores.chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [],
			conflicts: [],
		});
		const job = stores.jobStore.createJob({
			kind: "pdf",
			chatId: chat.id,
			toolCallId: "course-assign:2:/course/a.pdf",
			activity: "assigning /course/a.pdf",
			input: { path: "/course/a.pdf", nodeIds: ["n1"] },
		});

		const events: string[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "course-material-changed") {
				events.push(`${event.type}:${event.chatId}`);
			}
		});

		try {
			const wakeState = (globalThis as { __lhWakePipeline?: { lastSweepAt: number } }).__lhWakePipeline;
			if (wakeState) wakeState.lastSweepAt = 0;
			recoverStaleJobs();

			const updatedJob = stores.jobStore.getJob(job.id);
			assert.equal(updatedJob?.status, "error");
			assert.equal(updatedJob?.error, "Assignment was interrupted.");
			assert.equal(updatedJob?.activity, "failed");

			const file = stores.chatStore.getChat(chat.id)?.courseMaterial?.files[0];
			assert.equal(file?.status, "failed");
			assert.equal(file?.error, "Assignment was interrupted.");
			assert.deepEqual(events, [`course-material-changed:${chat.id}`]);
		} finally {
			unsubscribe();
		}
	});

	it("skips live course-assign jobs during stale-job recovery", () => {
		const chat = stores.chatStore.createChat("Course Live Sweep Test");
		stores.chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/live.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [],
			conflicts: [],
		});
		const job = stores.jobStore.createJob({
			kind: "pdf",
			chatId: chat.id,
			toolCallId: "course-assign:3:/course/live.pdf",
			activity: "assigning /course/live.pdf",
			input: { path: "/course/live.pdf", nodeIds: ["n1"] },
		});
		const controller = new AbortController();
		registerJobAbort(job.id, controller);

		try {
			const wakeState = (globalThis as { __lhWakePipeline?: { lastSweepAt: number } }).__lhWakePipeline;
			if (wakeState) wakeState.lastSweepAt = 0;
			recoverStaleJobs();

			assert.equal(stores.jobStore.getJob(job.id)?.status, "running");
			assert.equal(stores.chatStore.getChat(chat.id)?.courseMaterial?.files[0]?.status, "assigning");
		} finally {
			unregisterJobAbort(job.id);
		}
	});
});
