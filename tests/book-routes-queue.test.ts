import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BookRouteWorker } from "../src/core/book-routes.ts";
import type { ChatRecord, CourseMaterial, JobRecord, PlanTree } from "../src/core/contracts.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { createCourseAssignQueue } from "../src/server/course-assign-queue.ts";

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
		createdAt: "2026-11-25T00:00:00.000Z",
		updatedAt: "2026-11-25T00:00:00.000Z",
		messages: [],
		tree: tree ?? {
			nodes: [
				{ id: "n1", title: "Laplace Transform", summary: "Definition" },
				{ id: "n2", title: "Poles and Zeros", summary: "Stability" },
			],
			edges: [],
			version: 1,
		},
		courseMaterial: material,
	};
}

const FILE_TIME = "2026-11-25T00:00:00.000Z";

describe("book-routes-queue", () => {
	// plan 020 part 3: activity dock label, serial execution, BookRoute storage, and course-material-changed emission
	it("runs book-route jobs serially, sets dock label, stores BookRoute, and emits", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/oppenheim.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "s. 1", method: "Overview 1" },
				{ nodeId: "n2", path: "/course/slides.pdf", pages: "s. 2", method: "Overview 2" },
			],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/oppenheim.pdf",
					from: "outline",
					sections: [
						{ id: "s1", title: "Ch 1", level: 1, startPage: 10, endPage: 15 },
						{ id: "s2", title: "Ch 2", level: 1, startPage: 16, endPage: 22 },
					],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/oppenheim.pdf", sectionIds: ["s1"] },
				{ nodeId: "n2", path: "/course/oppenheim.pdf", sectionIds: ["s2"] },
			],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const emitted: string[] = [];
		let active = 0;
		let maxConcurrent = 0;

		const bookRouteWorker: BookRouteWorker = async (input) => {
			active++;
			maxConcurrent = Math.max(maxConcurrent, active);
			await Promise.resolve();
			active--;
			return { ok: true, pages: "p. 10", method: `Book route for ${input.nodeId}` };
		};

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker,
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
		});

		await queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/oppenheim.pdf", sectionIds: ["s1"] },
			{ nodeId: "n2", path: "/course/oppenheim.pdf", sectionIds: ["s2"] },
		]);

		assert.equal(maxConcurrent, 1);
		assert.deepEqual(jobStore.all().map((j) => j.activity), [
			"Reading oppenheim.pdf for Laplace Transform",
			"Reading oppenheim.pdf for Poles and Zeros",
		]);
		assert.ok(jobStore.all().every((j) => j.status === "done"));
		assert.equal(emitted.length, 2);
		assert.deepEqual(chatStore.getChat("chat_1")?.courseMaterial?.bookRoutes, [
			{ nodeId: "n1", path: "/course/oppenheim.pdf", sectionIds: ["s1"], pages: "p. 10", method: "Book route for n1" },
			{ nodeId: "n2", path: "/course/oppenheim.pdf", sectionIds: ["s2"], pages: "p. 10", method: "Book route for n2" },
		]);
	});

	// plan 020 part 3: never enqueue a target already queued or running
	it("deduplicates targets that are already queued or running", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let calls = 0;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			// resolved inside worker
			void resolve;
		});
		let signalFirstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalFirstStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		void firstStarted;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker: async () => {
				calls++;
				signalFirstStarted();
				await gate;
				return { ok: true, pages: "p. 1", method: "Derivation" };
			},
		});

		const first = queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);
		await started;
		const second = queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);
		releaseFirst();
		await Promise.all([first, second]);

		assert.equal(calls, 1);
	});

	// plan 020 part 3: failed worker result (including "not covered") stores failed BookRoute with error
	it("stores a failed BookRoute with error when the worker fails or reports not covered", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker: async () => ({ ok: false, error: "not covered" }),
		});

		await queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);

		assert.deepEqual(chatStore.getChat("chat_1")?.courseMaterial?.bookRoutes, [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "", method: "", error: "not covered" },
		]);
		assert.equal(jobStore.all()[0]?.status, "error");
	});

	it("stores a failed BookRoute with empty pages and method when the worker throws", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker: async () => {
				throw new Error("worker crashed");
			},
		});

		await queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);

		assert.deepEqual(chatStore.getChat("chat_1")?.courseMaterial?.bookRoutes, [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "", method: "", error: "Assignment was interrupted." },
		]);
		assert.equal(jobStore.all()[0]?.status, "error");
	});

	// plan 020 part 3: trigger after every finished queue job of the chat (assignment, pointer mapping, label)
	it("triggers due book routes automatically after an assignment or label job finishes", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "pending" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const bookCalls: string[] = [];

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({
				ok: true,
				result: {
					category: "material",
					materialKind: "overview",
					nodes: [{ nodeId: "n1", pages: "s. 1", method: "Overview", sameRouteAsExisting: null }],
				},
			}),
			bookRouteWorker: async (input) => {
				bookCalls.push(input.nodeId);
				return { ok: true, pages: "p. 2", method: "Derived from book" };
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/slides.pdf", nodeIds: ["n1"] }]);

		assert.deepEqual(bookCalls, ["n1"]);
		assert.deepEqual(chatStore.getChat("chat_1")?.courseMaterial?.bookRoutes, [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 2", method: "Derived from book" },
		]);
	});

	// plan 020 part 3: the worker gets only the binding Overview routes of the node as context (unticked files excluded)
	it("passes only binding Overview methods of the node to the book-route worker", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/old-slides.pdf", addedAt: FILE_TIME, via: "learner", binding: false, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", method: "Binding overview" },
				{ nodeId: "n1", path: "/course/old-slides.pdf", method: "Unticked overview" },
			],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const seen: Array<{ path: string; method: string }[]> = [];

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker: async (input) => {
				seen.push(input.overviewMethods.map((m) => ({ path: m.path, method: m.method })));
				return { ok: true, pages: "p. 1", method: "Book route" };
			},
		});

		await queue.enqueueBookRoutes("chat_1", [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }]);

		assert.deepEqual(seen, [[{ path: "/course/slides.pdf", method: "Binding overview" }]]);
	});

	// plan 020 part 3: discards result if reference file is removed or node is dropped while running
	it("discards the result if the node is dropped from the tree while running", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/slides.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
				{ path: "/course/book.pdf", addedAt: FILE_TIME, via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview" }],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: [{ id: "s1", title: "Ch 1", level: 1, startPage: 1, endPage: 5 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }],
		});
		const { chatStore, jobStore, chats } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "overview", nodes: [] } }),
			bookRouteWorker: async () => {
				const current = chats.get("chat_1")!;
				chats.set("chat_1", {
					...current,
					tree: { nodes: [{ id: "n2", title: "Poles and Zeros", summary: "Stability" }], edges: [], version: 2 },
				});
				return { ok: true, pages: "p. 1", method: "Stale node route" };
			},
		});

		await queue.enqueueBookRoutes("chat_1", [
			{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
		]);

		assert.deepEqual(chatStore.getChat("chat_1")?.courseMaterial?.bookRoutes ?? [], []);
	});
});
