import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, CourseMaterial, JobRecord, PlanTree } from "../src/core/contracts.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import {
	createCourseAssignQueue,
	type CourseAssignWorker,
} from "../src/server/course-assign-queue.ts";

function makeMemoryStores(chat: ChatRecord) {
	const chats = new Map<string, ChatRecord>([[chat.id, chat]]);
	const jobs = new Map<string, JobRecord>();
	let jobSeq = 0;

	const chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial"> = {
		getChat(id) {
			return chats.get(id) ?? null;
		},
		setCourseMaterial(chatId, material) {
			const existing = chats.get(chatId);
			if (!existing) throw new Error(`Chat not found: ${chatId}`);
			chats.set(chatId, { ...existing, courseMaterial: material });
		},
	};

	const jobStore: Pick<JobStore, "createJob" | "updateJob"> & { all(): JobRecord[] } = {
		createJob(init: CreateJobInit) {
			const now = new Date().toISOString();
			const record: JobRecord = {
				id: `job_${++jobSeq}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				status: "running",
				activity: init.activity ?? "starting",
				createdAt: now,
				updatedAt: now,
			};
			jobs.set(record.id, record);
			return record;
		},
		updateJob(id: string, patch: JobPatch) {
			const existing = jobs.get(id);
			if (!existing) return null;
			const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
			jobs.set(id, next);
			return next;
		},
		all() {
			return [...jobs.values()];
		},
	};

	return { chatStore, jobStore, chats };
}

function makeChat(material: CourseMaterial, tree?: PlanTree): ChatRecord {
	return {
		id: "chat_1",
		title: "Control Systems",
		createdAt: "2026-11-22T00:00:00.000Z",
		updatedAt: "2026-11-22T00:00:00.000Z",
		messages: [],
		tree: tree ?? {
			nodes: [
				{ id: "n1", title: "Node 1", summary: "First" },
				{ id: "n2", title: "Node 2", summary: "Second" },
			],
			edges: [],
			version: 1,
		},
		courseMaterial: material,
	};
}

describe("course-assign-queue", () => {
	// plan 007 part 3: one serial queue per chat; status moves to assigning on start; every status change saves and emits course-material-changed
	it("runs jobs serially per chat, sets assigning then assigned, and emits on each status change", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const emitted: string[] = [];
		const events: string[] = [];
		let active = 0;
		let maxConcurrent = 0;

		const worker: CourseAssignWorker = async (input) => {
			active++;
			maxConcurrent = Math.max(maxConcurrent, active);
			events.push(`start:${input.path}:${chatStore.getChat(input.chatId)?.courseMaterial?.files.find((f) => f.path === input.path)?.status}`);
			await Promise.resolve();
			active--;
			events.push(`end:${input.path}`);
			return {
				ok: true,
				result: {
					category: "material",
					nodes: [{ nodeId: "n1", pages: "p. 1", method: `From ${input.path}`, sameRouteAsExisting: input.path === "/course/b.pdf" ? true : null }],
				},
			};
		};

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker,
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
		});

		await queue.enqueue("chat_1", [
			{ path: "/course/a.pdf", nodeIds: ["n1", "n2"] },
			{ path: "/course/b.pdf", nodeIds: ["n1", "n2"] },
		]);

		assert.equal(maxConcurrent, 1);
		assert.deepEqual(events, [
			"start:/course/a.pdf:assigning",
			"end:/course/a.pdf",
			"start:/course/b.pdf:assigning",
			"end:/course/b.pdf",
		]);
		assert.equal(emitted.length, 4);
		const saved = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(saved?.files[0]?.status, "assigned");
		assert.equal(saved?.files[1]?.status, "assigned");
		assert.equal(saved?.methods.length, 2);
	});

	// plan 007 part 3: job is registered in the job store so the activity dock shows it
	it("registers a running job in jobStore during execution and marks it terminal afterwards", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let sawRunning = false;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => {
				sawRunning = jobStore.all().some((j) => j.chatId === "chat_1" && j.status === "running");
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		assert.equal(sawRunning, true);
		assert.equal(jobStore.all().length, 1);
		assert.notEqual(jobStore.all()[0]?.status, "running");
	});

	// plan 007 part 3: worker receives methods other binding files already gave each target node
	it("passes methods stored by earlier jobs to subsequent jobs in the same chat", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let secondExisting: Record<string, Array<{ path: string; method: string }>> | undefined;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				if (input.path === "/course/b.pdf") {
					secondExisting = input.existingMethods;
				}
				return {
					ok: true,
					result: {
						category: "material",
						nodes: [{ nodeId: "n1", pages: "p. 1", method: "Route A", sameRouteAsExisting: null }],
					},
				};
			},
		});

		await queue.enqueue("chat_1", [
			{ path: "/course/a.pdf", nodeIds: ["n1"] },
			{ path: "/course/b.pdf", nodeIds: ["n1"] },
		]);

		assert.deepEqual(secondExisting, {
			n1: [{ path: "/course/a.pdf", method: "Route A" }],
		});
	});

	// plan 007 part 3: one serial queue per chat — separate concurrent enqueue calls run one at a time, in order
	it("runs jobs from concurrent enqueue calls for the same chat serially in FIFO order", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const events: string[] = [];
		let active = 0;
		let maxConcurrent = 0;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				active++;
				maxConcurrent = Math.max(maxConcurrent, active);
				events.push(`start:${input.path}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				events.push(`end:${input.path}`);
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		await Promise.all([
			queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]),
			queue.enqueue("chat_1", [{ path: "/course/b.pdf", nodeIds: ["n1"] }]),
		]);

		assert.equal(maxConcurrent, 1);
		assert.deepEqual(events, [
			"start:/course/a.pdf",
			"end:/course/a.pdf",
			"start:/course/b.pdf",
			"end:/course/b.pdf",
		]);
	});

	// plan 007 part 3: worker input targets are { id, title, summary?, unitTitle?, unitSource? } resolved from the chat's tree
	it("resolves target nodes from the chat tree into worker input targets", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let seen: unknown;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				seen = input.targets;
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n2"] }]);

		assert.deepEqual(seen, [{ id: "n2", title: "Node 2", summary: "Second" }]);
	});

	// plan 007 part 3: existing methods come only from OTHER binding files (not unticked files, not the file's own prior methods)
	it("excludes unticked files' methods and the target file's own prior methods from existingMethods", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: false, status: "assigned" },
				{ path: "/course/c.pdf", addedAt: "2026-11-22T00:02:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Own old" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 2", method: "Unticked" },
				{ nodeId: "n1", path: "/course/c.pdf", pages: "p. 3", method: "Other binding" },
			],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let existing: Record<string, Array<{ path: string; method: string }>> | undefined;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				existing = input.existingMethods;
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		assert.deepEqual(existing, { n1: [{ path: "/course/c.pdf", method: "Other binding" }] });
	});

	// plan 007 part 3: worker failure result marks file failed with the worker error and emits course-material-changed
	it("marks file failed with the worker error on failure result", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const emitted: string[] = [];

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: false, error: "unknown node id \"bogus\"" }),
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(file?.status, "failed");
		assert.equal(file?.error, "unknown node id \"bogus\"");
		assert.equal(emitted.length, 2);
		assert.equal(jobStore.all()[0]?.status, "error");
	});

	// plan 007 part 3: crashed (throwing) worker leaves status failed with "Assignment was interrupted." and emits course-material-changed
	it("sets status failed with 'Assignment was interrupted.' when the worker throws", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const emitted: string[] = [];

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => {
				throw new Error("boom");
			},
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(file?.status, "failed");
		assert.equal(file?.error, "Assignment was interrupted.");
		assert.equal(emitted.length, 2);
		assert.equal(jobStore.all()[0]?.status, "error");
	});

	// plan 007 part 3: aborted job leaves status failed with "Assignment was interrupted."
	it("sets status failed with 'Assignment was interrupted.' when the worker rejects with AbortError", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(file?.status, "failed");
		assert.equal(file?.error, "Assignment was interrupted.");
	});

	it("registers abort controller while running and fails if aborted even when worker resolves", async () => {
		const { fireJobAbort, isJobLive } = await import("../src/agent/subagents/aborts.ts");
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let liveDuringRun = false;
		let abortedDuringRun = false;
		let runningJobId = "";

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				const running = jobStore.all().find((j) => j.status === "running");
				assert.ok(running);
				runningJobId = running.id;
				liveDuringRun = isJobLive(running.id);
				assert.equal(fireJobAbort(running.id), true);
				abortedDuringRun = input.abortSignal.aborted;
				return {
					ok: true,
					result: {
						category: "material",
						nodes: [{ nodeId: "n1", pages: "p. 1", method: "Should not save", sameRouteAsExisting: null }],
					},
				};
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);

		assert.equal(liveDuringRun, true);
		assert.equal(abortedDuringRun, true);
		assert.equal(isJobLive(runningJobId), false);
		const material = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "failed");
		assert.equal(material?.files[0]?.error, "Assignment was interrupted.");
		assert.equal(material?.methods.length, 0);
		assert.equal(jobStore.all()[0]?.status, "error");
	});

	it("filters out nodes removed from the chat tree while the worker is running", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [{ nodeId: "n1", path: "/course/b.pdf", method: "Existing n1" }],
			conflicts: [],
		});
		const { chatStore, jobStore, chats } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => {
				const current = chats.get("chat_1");
				assert.ok(current);
				chats.set("chat_1", {
					...current,
					tree: {
						nodes: [{ id: "n1", title: "Node 1", summary: "First" }],
						edges: [],
						version: 2,
					},
				});
				return {
					ok: true,
					result: {
						category: "material",
						nodes: [
							{ nodeId: "n1", pages: "p. 1", method: "Keep n1", sameRouteAsExisting: true },
							{ nodeId: "n2", pages: "p. 2", method: "Removed n2", sameRouteAsExisting: false },
						],
					},
				};
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1", "n2"] }]);

		const material = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.deepEqual(
			material?.methods.filter((m) => m.path === "/course/a.pdf"),
			[{ nodeId: "n1", path: "/course/a.pdf", pages: "p. 1", method: "Keep n1" }],
		);
		assert.deepEqual(material?.conflicts, []);
	});
});
