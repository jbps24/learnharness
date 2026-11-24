import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, CourseMaterial, JobRecord, PlanTree } from "../src/core/contracts.ts";
import { removeCourseFile } from "../src/core/course-remove.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { createCourseAssignQueue, type CourseAssignWorker } from "../src/server/course-assign-queue.ts";

function makeMemoryStores(chat: ChatRecord) {
	const chats = new Map<string, ChatRecord>([[chat.id, chat]]);
	const jobs = new Map<string, JobRecord>();
	let jobSeq = 0;
	let setCourseMaterialCalls = 0;

	const chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial"> = {
		getChat(id) {
			return chats.get(id) ?? null;
		},
		setCourseMaterial(chatId, material) {
			const existing = chats.get(chatId);
			if (!existing) throw new Error(`Chat not found: ${chatId}`);
			setCourseMaterialCalls++;
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

	return {
		chatStore,
		jobStore,
		chats,
		get setCourseMaterialCalls() {
			return setCourseMaterialCalls;
		},
	};
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

describe("course-assign-queue removal and cancel", () => {
	// plan 014 part 1: a job whose path is no longer in the material's files is skipped (no status write, no worker call)
	it("skips a queued job whose path was removed before it starts without calling the worker or writing status", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const stores = makeMemoryStores(chat);
		const workerPaths: string[] = [];
		const emitted: string[] = [];

		let resolveFirstStarted!: () => void;
		const firstStarted = new Promise<void>((r) => {
			resolveFirstStarted = r;
		});
		let releaseFirst!: () => void;
		const waitFirst = new Promise<void>((r) => {
			releaseFirst = r;
		});

		const queue = createCourseAssignQueue({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
			worker: async (input) => {
				workerPaths.push(input.path);
				if (input.path === "/course/a.pdf") {
					resolveFirstStarted();
					await waitFirst;
				}
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		const run = queue.enqueue("chat_1", [
			{ path: "/course/a.pdf", nodeIds: ["n1"] },
			{ path: "/course/b.pdf", nodeIds: ["n1"] },
		]);

		await firstStarted;
		const current = stores.chatStore.getChat("chat_1")!.courseMaterial!;
		stores.chatStore.setCourseMaterial("chat_1", removeCourseFile(current, "/course/b.pdf"));
		releaseFirst();

		await run;
		assert.deepEqual(workerPaths, ["/course/a.pdf"]);
		assert.equal(stores.jobStore.all().length, 1);
		assert.equal(emitted.length, 2);
	});

	// plan 014 part 1: cancel aborts the running job for that chat and path, and leaves other chats/paths alone
	it("aborts the running job matching chatId and path on cancel", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const stores = makeMemoryStores(chat);

		let signal!: AbortSignal;
		let resolveStarted!: () => void;
		const started = new Promise<void>((r) => {
			resolveStarted = r;
		});
		let resolveWorker!: () => void;
		const workerDone = new Promise<void>((r) => {
			resolveWorker = r;
		});

		const queue = createCourseAssignQueue({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			worker: async (input) => {
				signal = input.abortSignal;
				resolveStarted();
				await workerDone;
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		const run = queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);
		await started;

		// Unrelated chat or path does not abort
		queue.cancel("chat_other", "/course/a.pdf");
		queue.cancel("chat_1", "/course/other.pdf");
		assert.equal(signal.aborted, false);

		// Matching chatId and path aborts
		queue.cancel("chat_1", "/course/a.pdf");
		assert.equal(signal.aborted, true);

		resolveWorker();
		await run;
	});

	// plan 014 part 1: after worker returns ok, writes nothing when path is no longer listed and job store ends as error with "Removed from the list."
	it("discards worker success result when the path was removed while running and marks job error with 'Removed from the list.'", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const stores = makeMemoryStores(chat);
		const emitted: string[] = [];

		let resolveStarted!: () => void;
		const started = new Promise<void>((r) => {
			resolveStarted = r;
		});
		let resolveWorker!: () => void;
		const workerDone = new Promise<void>((r) => {
			resolveWorker = r;
		});

		const worker: CourseAssignWorker = async () => {
			resolveStarted();
			await workerDone;
			return {
				ok: true,
				result: {
					category: "material",
					nodes: [{ nodeId: "n1", pages: "p. 1", method: "Should not be saved", sameRouteAsExisting: null }],
				},
			};
		};

		const queue = createCourseAssignQueue({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
			worker,
		});

		const run = queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);
		await started;

		// Simulate DELETE route removing the file before the worker finishes (without even firing abort, or with cancel)
		const current = stores.chatStore.getChat("chat_1")!.courseMaterial!;
		stores.chatStore.setCourseMaterial("chat_1", removeCourseFile(current, "/course/a.pdf"));
		const writesAfterRemove = stores.setCourseMaterialCalls;
		const emitsAfterRemove = emitted.length;

		resolveWorker();
		await run;

		assert.equal(stores.setCourseMaterialCalls, writesAfterRemove);
		assert.equal(emitted.length, emitsAfterRemove);
		const saved = stores.chatStore.getChat("chat_1")?.courseMaterial;
		assert.deepEqual(saved?.files, []);
		assert.deepEqual(saved?.methods, []);
		assert.equal(stores.jobStore.all()[0]?.status, "error");
		assert.equal(stores.jobStore.all()[0]?.error, "Removed from the list.");
	});

	// plan 014 part 1: after worker returns failure or throws, writes nothing when path is no longer listed and job store ends as error with "Removed from the list."
	it("writes no status and marks job error with 'Removed from the list.' when worker throws after cancel and removal", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const stores = makeMemoryStores(chat);
		const emitted: string[] = [];

		let resolveStarted!: () => void;
		const started = new Promise<void>((r) => {
			resolveStarted = r;
		});

		const queue = createCourseAssignQueue({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
			worker: async (input) => {
				if (input.path === "/course/a.pdf") {
					resolveStarted();
					await new Promise<void>((_resolve, reject) => {
						input.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				}
				return {
					ok: true,
					result: {
						category: "material",
						nodes: [{ nodeId: "n1", pages: "p. 1", method: "Kept", sameRouteAsExisting: null }],
					},
				};
			},
		});

		const run = queue.enqueue("chat_1", [
			{ path: "/course/a.pdf", nodeIds: ["n1"] },
			{ path: "/course/b.pdf", nodeIds: ["n1"] },
		]);
		await started;

		const current = stores.chatStore.getChat("chat_1")!.courseMaterial!;
		stores.chatStore.setCourseMaterial("chat_1", removeCourseFile(current, "/course/a.pdf"));
		queue.cancel("chat_1", "/course/a.pdf");

		await run;

		const jobs = stores.jobStore.all();
		assert.equal(jobs.length, 2);
		assert.equal(jobs[0]?.status, "error");
		assert.equal(jobs[0]?.error, "Removed from the list.");
		assert.equal(jobs[1]?.status, "done");

		const saved = stores.chatStore.getChat("chat_1")?.courseMaterial;
		assert.deepEqual(
			saved?.files.map((f) => ({ path: f.path, status: f.status })),
			[{ path: "/course/b.pdf", status: "assigned" }],
		);
		assert.deepEqual(saved?.methods, [{ nodeId: "n1", path: "/course/b.pdf", pages: "p. 1", method: "Kept" }]);
	});

	// plan 014 part 1 + decision 1: a cancelled job never touches a file re-added before the worker settles; the dock shows it failed
	it("leaves a re-added file pending when the cancelled worker throws after the re-add, and marks the job failed", async () => {
		const file = { path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner" as const, binding: true, status: "pending" as const };
		const stores = makeMemoryStores(makeChat({ files: [file], methods: [], conflicts: [] }));

		let resolveStarted!: () => void;
		const started = new Promise<void>((r) => {
			resolveStarted = r;
		});
		let releaseWorker!: () => void;
		const workerGate = new Promise<void>((r) => {
			releaseWorker = r;
		});

		const queue = createCourseAssignQueue({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			worker: async (input) => {
				resolveStarted();
				await workerGate;
				if (input.abortSignal.aborted) throw new Error("aborted");
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		const run = queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);
		await started;

		const current = stores.chatStore.getChat("chat_1")!.courseMaterial!;
		stores.chatStore.setCourseMaterial("chat_1", removeCourseFile(current, "/course/a.pdf"));
		queue.cancel("chat_1", "/course/a.pdf");
		const readded = { ...file, addedAt: "2026-11-22T00:05:00.000Z" };
		stores.chatStore.setCourseMaterial("chat_1", { files: [readded], methods: [], conflicts: [] });
		const writesAfterReadd = stores.setCourseMaterialCalls;

		releaseWorker();
		await run;

		assert.equal(stores.setCourseMaterialCalls, writesAfterReadd);
		assert.deepEqual(stores.chatStore.getChat("chat_1")?.courseMaterial?.files, [readded]);
		const [job] = stores.jobStore.all();
		assert.equal(job?.status, "error");
		assert.equal(job?.error, "Removed from the list.");
		assert.equal(job?.activity, "failed");
	});

	for (const outcome of ["throws", "fails"] as const) {
		// plan 014 part 1: after the worker returns a failure or throws, the queue writes nothing (no status, no emit) when the path is no longer listed
		it(`writes nothing and ends the job as error 'Removed from the list.' when the worker ${outcome} for a removed path`, async () => {
			const chat = makeChat({
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				],
				methods: [],
				conflicts: [],
			});
			const stores = makeMemoryStores(chat);
			const emitted: string[] = [];

			let resolveStarted!: () => void;
			const started = new Promise<void>((r) => {
				resolveStarted = r;
			});
			let releaseWorker!: () => void;
			const workerGate = new Promise<void>((r) => {
				releaseWorker = r;
			});

			const queue = createCourseAssignQueue({
				chatStore: stores.chatStore,
				jobStore: stores.jobStore,
				emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
				worker: async () => {
					resolveStarted();
					await workerGate;
					if (outcome === "throws") throw new Error("boom");
					return { ok: false, error: "could not read" } as never;
				},
			});

			const run = queue.enqueue("chat_1", [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);
			await started;

			const current = stores.chatStore.getChat("chat_1")!.courseMaterial!;
			stores.chatStore.setCourseMaterial("chat_1", removeCourseFile(current, "/course/a.pdf"));
			queue.cancel("chat_1", "/course/a.pdf");
			const writesAfterRemove = stores.setCourseMaterialCalls;
			const emitsAfterRemove = emitted.length;

			releaseWorker();
			await run;

			assert.equal(stores.setCourseMaterialCalls, writesAfterRemove);
			assert.equal(emitted.length, emitsAfterRemove);
			assert.deepEqual(stores.chatStore.getChat("chat_1")?.courseMaterial?.files, []);
			assert.equal(stores.jobStore.all()[0]?.status, "error");
			assert.equal(stores.jobStore.all()[0]?.error, "Removed from the list.");
		});
	}
});
