import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, CourseMaterial, JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { createCourseAssignQueue } from "../src/server/course-assign-queue.ts";

function createStores(chat: ChatRecord) {
	const chats = new Map<string, ChatRecord>([[chat.id, chat]]);
	const jobs = new Map<string, JobRecord>();
	let seq = 0;

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

	const jobStore: Pick<JobStore, "createJob" | "updateJob"> & { list(): JobRecord[] } = {
		createJob(init: CreateJobInit) {
			const now = new Date().toISOString();
			const record: JobRecord = {
				id: `job_${++seq}`,
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
		list() {
			return [...jobs.values()];
		},
	};

	return { chatStore, jobStore };
}

function createChat(material: CourseMaterial): ChatRecord {
	return {
		id: "chat_mismatch_1",
		title: "Control Systems",
		createdAt: "2026-11-23T00:00:00.000Z",
		updatedAt: "2026-11-23T00:00:00.000Z",
		messages: [],
		tree: {
			nodes: [{ id: "n1", title: "Root locus", summary: "Sketch and poles" }],
			edges: [],
			version: 1,
		},
		courseMaterial: material,
	};
}

async function captureConsoleWarns(run: () => Promise<void>): Promise<unknown[][]> {
	const calls: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		calls.push(args);
	};
	try {
		await run();
	} finally {
		console.warn = originalWarn;
	}
	return calls;
}

describe("course-assign-queue (learner category mismatch log)", () => {
	// plan 010 part 2: learner-set exam vs reader material logs one warning and keeps learner category as assigned/done
	it("warns once with chat id, path, reader category, and learner category when learner set exam and reader answers material", async () => {
		const chat = createChat({
			files: [
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					category: "exam",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = createStores(chat);
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({
				ok: true,
				result: {
					category: "material",
					nodes: [{ nodeId: "n1", pages: "p. 1", method: "Ignored method", sameRouteAsExisting: null }],
				},
			}),
		});

		const warns = await captureConsoleWarns(() =>
			queue.enqueue("chat_mismatch_1", [{ path: "/course/ws22.pdf", nodeIds: ["n1"] }]),
		);

		assert.equal(warns.length, 1);
		const line = warns[0]?.map(String).join(" ") ?? "";
		assert.ok(line.includes("chat_mismatch_1"));
		assert.ok(line.includes("/course/ws22.pdf"));
		assert.ok(line.includes("material"));
		assert.ok(line.includes("exam"));
		assert.equal(line, "[chat chat_mismatch_1] course assignment of /course/ws22.pdf: the reader answered material, the learner set exam; answer ignored");

		const material = chatStore.getChat("chat_mismatch_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[0]?.category, "exam");
		assert.equal(material?.files[0]?.categoryBy, "learner");
		assert.deepEqual(material?.methods, []);
		assert.equal(jobStore.list()[0]?.status, "done");
	});

	// plan 010 part 2: learner-set material vs reader exam also logs one warning and keeps learner category
	it("warns once when learner set material and reader answers exam", async () => {
		const chat = createChat({
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					category: "material",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = createStores(chat);
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({
				ok: true,
				result: {
					category: "exam",
					nodes: [{ nodeId: "n1", source: "A1", pages: "S. 1", pattern: "Ignored pattern" }],
				},
			}),
		});

		const warns = await captureConsoleWarns(() =>
			queue.enqueue("chat_mismatch_1", [{ path: "/course/notes.pdf", nodeIds: ["n1"] }]),
		);

		assert.equal(warns.length, 1);
		assert.equal(
			warns[0]?.map(String).join(" "),
			"[chat chat_mismatch_1] course assignment of /course/notes.pdf: the reader answered exam, the learner set material; answer ignored",
		);
		const material = chatStore.getChat("chat_mismatch_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[0]?.category, "material");
		assert.equal(material?.files[0]?.categoryBy, "learner");
		assert.deepEqual(material?.examPatterns ?? [], []);
		assert.equal(jobStore.list()[0]?.status, "done");
	});

	// plan 010 part 2: no mismatch warning when learner-set category matches the reader's answer
	it("does not warn when the learner-set category matches the reader answer", async () => {
		const chat = createChat({
			files: [
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					category: "exam",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = createStores(chat);
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({
				ok: true,
				result: {
					category: "exam",
					nodes: [{ nodeId: "n1", source: "WS22 A1", pages: "S. 1", pattern: "Pattern 1" }],
				},
			}),
		});

		const warns = await captureConsoleWarns(() =>
			queue.enqueue("chat_mismatch_1", [{ path: "/course/ws22.pdf", nodeIds: ["n1"] }]),
		);

		assert.deepEqual(warns, []);
		assert.equal(chatStore.getChat("chat_mismatch_1")?.courseMaterial?.files[0]?.status, "assigned");
		assert.equal(jobStore.list()[0]?.status, "done");
	});

	// plan 010 part 2: no mismatch warning when category is not learner-set
	it("does not warn when categoryBy is reader or unset even if the reader chooses the other category", async () => {
		const chat = createChat({
			files: [
				{
					path: "/course/reader-set.pdf",
					addedAt: "2026-11-23T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					category: "exam",
					categoryBy: "reader",
				},
				{
					path: "/course/unset.pdf",
					addedAt: "2026-11-23T00:01:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
				},
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = createStores(chat);
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => ({
				ok: true,
				result:
					input.path === "/course/reader-set.pdf"
						? { category: "material", nodes: [{ nodeId: "n1", pages: "p. 1", method: "Route", sameRouteAsExisting: null }] }
						: { category: "exam", nodes: [{ nodeId: "n1", source: "A1", pages: "S. 1", pattern: "Pattern" }] },
			}),
		});

		const warns = await captureConsoleWarns(() =>
			queue.enqueue("chat_mismatch_1", [
				{ path: "/course/reader-set.pdf", nodeIds: ["n1"] },
				{ path: "/course/unset.pdf", nodeIds: ["n1"] },
			]),
		);

		assert.deepEqual(warns, []);
		const files = chatStore.getChat("chat_mismatch_1")?.courseMaterial?.files;
		assert.equal(files?.[0]?.category, "material");
		assert.equal(files?.[0]?.categoryBy, "reader");
		assert.equal(files?.[1]?.category, "exam");
		assert.equal(files?.[1]?.categoryBy, "reader");
	});
});
