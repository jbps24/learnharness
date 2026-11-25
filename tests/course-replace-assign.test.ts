import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createCourseAssignWorker } from "../src/agent/subagents/course-assign.ts";
import type { ChatRecord, CourseMaterial, JobRecord, PlanTree } from "../src/core/contracts.ts";
import { applyAssignment } from "../src/core/course-assign.ts";
import { startReplacement } from "../src/core/course-replace.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { createCourseAssignQueue, type CourseAssignWorker } from "../src/server/course-assign-queue.ts";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-replace-assign-"));

after(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

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

	const jobStore: Pick<JobStore, "createJob" | "updateJob"> = {
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
	};

	return { chatStore, jobStore };
}

function makeTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Node 1", summary: "First" },
			{ id: "n2", title: "Node 2", summary: "Second" },
			{ id: "n3", title: "Node 3", summary: "Third" },
		],
		edges: [],
		version: 1,
	};
}

describe("course-replace-assign", () => {
	// plan 015 part 2: applyAssignment stores methods and classifyUpdate fills update.nodes and update.newSections
	it("applyAssignment fills update.nodes and update.newSections for a replacement file", () => {
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/v1.md",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/v1.md", pages: "p. 1", method: "Old n1" },
				{ nodeId: "n2", path: "/course/v1.md", pages: "p. 2", method: "Old n2" },
				{ nodeId: "n3", path: "/course/v1.md", pages: "p. 3", method: "Old n3" },
			],
			conflicts: [],
		};
		const started = startReplacement(initial, "/course/v1.md", "/course/v2.md", "2026-11-24T12:00:00.000Z");
		const next = applyAssignment(
			started,
			"/course/v2.md",
			{
				category: "material",
				nodes: [
					{ nodeId: "n1", pages: "p. 1", method: "Old n1", sameRouteAsExisting: null, sameAsPreviousVersion: true },
					{ nodeId: "n2", pages: "p. 2", method: "New n2", sameRouteAsExisting: null, sameAsPreviousVersion: false },
				],
				newSections: [{ title: "Bonus topic", pages: "p. 20" }],
			},
			["n1", "n2", "n3"],
		);
		const file = next.files[0];
		assert.equal(file?.status, "assigned");
		assert.deepEqual(next.methods, [
			{ nodeId: "n1", path: "/course/v2.md", pages: "p. 1", method: "Old n1" },
			{ nodeId: "n2", path: "/course/v2.md", pages: "p. 2", method: "New n2" },
		]);
		assert.deepEqual(file?.update?.nodes, [
			{ nodeId: "n1", kind: "same" },
			{ nodeId: "n2", kind: "changed" },
			{ nodeId: "n3", kind: "dropped" },
		]);
		assert.deepEqual(file?.update?.newSections, [{ title: "Bonus topic", pages: "p. 20" }]);
	});

	// plan 015 part 2: queue in replace mode clears changedOnDisk, stores fingerprint at job start, passes previousMethods, and fills update
	it("queues replacement in replace mode, stores fingerprint, clears changedOnDisk, and fills update", async () => {
		const newPath = path.join(TMP_DIR, "v2.md");
		fs.writeFileSync(newPath, "# New version", "utf8");

		const initial: CourseMaterial = {
			files: [
				{
					path: newPath,
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					changedOnDisk: true,
					update: {
						at: "2026-11-24T12:00:00.000Z",
						fromPath: "/course/v1.md",
						previous: [{ nodeId: "n1", pages: "p. 1", method: "Old n1" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		};
		const chat: ChatRecord = {
			id: "chat_1",
			title: "Course",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [],
			tree: makeTree(),
			courseMaterial: initial,
		};
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let seenPrevious: Record<string, { pages?: string; method: string }> | undefined;
		let changedDuringRun: boolean | undefined;
		let fingerprintDuringRun: unknown;

		const worker: CourseAssignWorker = async (input) => {
			seenPrevious = input.previousMethods;
			fingerprintDuringRun = chatStore.getChat("chat_1")?.courseMaterial?.files[0]?.fingerprint;
			changedDuringRun = chatStore.getChat("chat_1")?.courseMaterial?.files[0]?.changedOnDisk;
			return {
				ok: true,
				result: {
					category: "material",
					nodes: [
						{ nodeId: "n1", pages: "p. 1", method: "New n1", sameRouteAsExisting: null, sameAsPreviousVersion: false },
						{ nodeId: "n2", pages: "p. 5", method: "Added n2", sameRouteAsExisting: null, sameAsPreviousVersion: null },
					],
					newSections: [{ title: "Extra", pages: "p. 12" }],
				},
			};
		};

		const queue = createCourseAssignQueue({ chatStore, jobStore, worker });
		await queue.enqueue("chat_1", [{ path: newPath, nodeIds: ["n1", "n2", "n3"], replace: true }]);

		assert.deepEqual(seenPrevious, { n1: { pages: "p. 1", method: "Old n1" } });
		assert.equal(Boolean(changedDuringRun), false);
		assert.ok(fingerprintDuringRun, "fingerprint is stored at job start, before the worker finishes");
		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.ok(file?.fingerprint);
		assert.equal(Boolean(file?.changedOnDisk), false);
		assert.deepEqual(file?.update?.nodes, [
			{ nodeId: "n1", kind: "changed" },
			{ nodeId: "n2", kind: "new" },
		]);
		assert.deepEqual(file?.update?.newSections, [{ title: "Extra", pages: "p. 12" }]);
	});

	// plan 015 part 2: abort a running job for path via cancel
	it("aborts a running job for the replaced path via cancel", async () => {
		const oldPath = path.join(TMP_DIR, "old.md");
		const newPath = path.join(TMP_DIR, "new.md");
		fs.writeFileSync(oldPath, "old", "utf8");
		fs.writeFileSync(newPath, "new", "utf8");

		const chat: ChatRecord = {
			id: "chat_2",
			title: "Course",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [],
			tree: makeTree(),
			courseMaterial: {
				files: [{ path: oldPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
				methods: [],
				conflicts: [],
			},
		};
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let abortedOld = false;
		let resolveStarted!: () => void;
		const started = new Promise<void>((r) => { resolveStarted = r; });

		const worker: CourseAssignWorker = async (input) => {
			if (input.path === oldPath) {
				resolveStarted();
				await new Promise<void>((resolve) => {
					input.abortSignal.addEventListener("abort", () => {
						abortedOld = true;
						resolve();
					});
				});
				return { ok: false, error: "aborted" };
			}
			return {
				ok: true,
				result: { category: "material", nodes: [] },
			};
		};

		const queue = createCourseAssignQueue({ chatStore, jobStore, worker });
		const firstRun = queue.enqueue("chat_2", [{ path: oldPath, nodeIds: ["n1"] }]);
		await started;

		const updated = startReplacement(chatStore.getChat("chat_2")!.courseMaterial!, oldPath, newPath, "2026-11-24T12:00:00.000Z");
		chatStore.setCourseMaterial("chat_2", updated);
		queue.cancel("chat_2", oldPath);
		await firstRun;

		assert.equal(abortedOld, true);
		assert.equal(chatStore.getChat("chat_2")?.courseMaterial?.files[0]?.path, newPath);
	});

	// plan 015 part 2: fingerprint stored at job start (any job), so a failed job keeps it
	it("stores the fingerprint at job start for a non-replace job that fails", async () => {
		const filePath = path.join(TMP_DIR, "plain.md");
		fs.writeFileSync(filePath, "plain", "utf8");
		const chat: ChatRecord = {
			id: "chat_3",
			title: "Course",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [],
			tree: makeTree(),
			courseMaterial: {
				files: [{ path: filePath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
				methods: [],
				conflicts: [],
			},
		};
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let duringRun: unknown;
		const worker: CourseAssignWorker = async () => {
			duringRun = chatStore.getChat("chat_3")?.courseMaterial?.files[0]?.fingerprint;
			return { ok: false, error: "boom" };
		};
		const queue = createCourseAssignQueue({ chatStore, jobStore, worker });
		await queue.enqueue("chat_3", [{ path: filePath, nodeIds: ["n1"] }]);
		assert.ok(duringRun);
		assert.equal(chatStore.getChat("chat_3")?.courseMaterial?.files[0]?.status, "failed");
		assert.ok(chatStore.getChat("chat_3")?.courseMaterial?.files[0]?.fingerprint);
	});
});

describe("createCourseAssignWorker in replace mode", () => {
	const REPLACE_PARAGRAPH_START = "This file replaces an earlier version of the same course file.";

	function makeEngine(steps: FauxResponseStep[], seen: string[]): PiEngine {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses(steps);
		return {
			model: faux.getModel(),
			streamFn: (model, context, opts) => {
				seen.push(JSON.stringify(context));
				return faux.streamSimple(model, context, opts);
			},
		};
	}

	// plan 015 part 2: replace mode shows previous methods, adds the confirmed paragraph, accepts the replace-mode fields
	it("shows previous methods, uses the replace-mode instructions and parses replace-mode fields", async () => {
		const file = path.join(TMP_DIR, "worker-v2.md");
		fs.writeFileSync(file, "# Chapter 1\nNew route\n", "utf8");
		const seen: string[] = [];
		const engine = makeEngine(
			[
				fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([
					fauxText(
						JSON.stringify({
							category: "material",
							materialKind: "complete",
							nodes: [{ nodeId: "n1", pages: "p. 1", method: "New route", sameRouteAsExisting: null, sameAsPreviousVersion: false }],
							newSections: [{ title: "Extra", pages: "p. 9" }],
						}),
					),
				]),
			],
			seen,
		);
		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_w",
			path: file,
			targets: [{ id: "n1", title: "Node 1" }],
			existingMethods: {},
			previousMethods: { n1: { pages: "S. 10", method: "Old Bode step." } },
			abortSignal: new AbortController().signal,
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok || outcome.result.category !== "material") return;
		assert.deepEqual(outcome.result.newSections, [{ title: "Extra", pages: "p. 9" }]);
		assert.equal(outcome.result.nodes[0]?.sameAsPreviousVersion, false);
		assert.ok(seen[0]?.includes("Old Bode step."));
		assert.ok(seen[0]?.includes(REPLACE_PARAGRAPH_START));
		assert.ok(seen[0]?.includes('\\"sameAsPreviousVersion\\": true when the route is the same'));
	});

	// plan 015 part 2: outside replace mode the replace paragraph is not part of the instructions
	it("leaves the replace-mode paragraph out of a normal run", async () => {
		const file = path.join(TMP_DIR, "worker-normal.md");
		fs.writeFileSync(file, "# Chapter 1\nRoute\n", "utf8");
		const seen: string[] = [];
		const engine = makeEngine(
			[
				fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText(JSON.stringify({ category: "material", materialKind: "complete", nodes: [] }))]),
			],
			seen,
		);
		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_w",
			path: file,
			targets: [{ id: "n1", title: "Node 1" }],
			existingMethods: {},
			abortSignal: new AbortController().signal,
		});
		assert.equal(outcome.ok, true);
		assert.equal(seen[0]?.includes(REPLACE_PARAGRAPH_START), false);
	});
});

describe("course-replace-assign edge cases", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-replace-extra-"));

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function localStores(chat: ChatRecord) {
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

		const jobStore: Pick<JobStore, "createJob" | "updateJob"> = {
			createJob(init: CreateJobInit) {
				const now = new Date().toISOString();
				const record: JobRecord = {
					id: `job_extra_${++seq}`,
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
		};

		return { chatStore, jobStore };
	}

	function scriptedEngine(steps: FauxResponseStep[], seen: string[]): PiEngine {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses(steps);
		return {
			model: faux.getModel(),
			streamFn: (model, context, opts) => {
				seen.push(JSON.stringify(context));
				return faux.streamSimple(model, context, opts);
			},
		};
	}

	it("classifies null sameAsPreviousVersion for a previously covered node as changed", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/v1.md", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/v1.md", pages: "p. 1", method: "Old n1" }],
			conflicts: [],
		};
		const started = startReplacement(initial, "/course/v1.md", "/course/v2.md", "2026-11-24T12:00:00.000Z");
		const next = applyAssignment(
			started,
			"/course/v2.md",
			{
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 1", method: "New n1", sameRouteAsExisting: null, sameAsPreviousVersion: null }],
			},
			["n1"],
		);
		assert.deepEqual(next.files[0]?.update?.nodes, [{ nodeId: "n1", kind: "changed" }]);
	});

	it("preserves changedOnDisk state across failed jobs without inverting it", async () => {
		const plainPath = path.join(dir, "fail-plain.md");
		const flaggedPath = path.join(dir, "fail-flagged.md");
		fs.writeFileSync(plainPath, "plain", "utf8");
		fs.writeFileSync(flaggedPath, "flagged", "utf8");

		const tree: PlanTree = { nodes: [{ id: "n1", title: "Node 1" }], edges: [], version: 1 };
		const chat1: ChatRecord = {
			id: "chat_q1",
			title: "Plain fail",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [],
			tree,
			courseMaterial: {
				files: [{ path: plainPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
				methods: [],
				conflicts: [],
			},
		};
		const stores1 = localStores(chat1);
		const queue1 = createCourseAssignQueue({
			chatStore: stores1.chatStore,
			jobStore: stores1.jobStore,
			worker: async () => ({ ok: false, error: "boom" }),
		});
		await queue1.enqueue("chat_q1", [{ path: plainPath, nodeIds: ["n1"] }]);
		assert.equal(Boolean(stores1.chatStore.getChat("chat_q1")?.courseMaterial?.files[0]?.changedOnDisk), false);

		const chat2: ChatRecord = {
			id: "chat_q2",
			title: "Flagged during run fail",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [],
			tree,
			courseMaterial: {
				files: [{ path: flaggedPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
				methods: [],
				conflicts: [],
			},
		};
		const stores2 = localStores(chat2);
		const queue2 = createCourseAssignQueue({
			chatStore: stores2.chatStore,
			jobStore: stores2.jobStore,
			worker: async () => {
				const mat = stores2.chatStore.getChat("chat_q2")!.courseMaterial!;
				stores2.chatStore.setCourseMaterial("chat_q2", {
					...mat,
					files: mat.files.map((f) => ({ ...f, changedOnDisk: true })),
				});
				return { ok: false, error: "boom" };
			},
		});
		await queue2.enqueue("chat_q2", [{ path: flaggedPath, nodeIds: ["n1"] }]);
		assert.equal(stores2.chatStore.getChat("chat_q2")?.courseMaterial?.files[0]?.changedOnDisk, true);
	});

	it("passes replace instructions to pdf-reader when replacing a PDF file", async () => {
		const pdfFixture = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
		const seen: string[] = [];
		const engine = scriptedEngine(
			[
				fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([
					fauxText(
						JSON.stringify({
							category: "material",
							materialKind: "complete",
							nodes: [{ nodeId: "n1", pages: "p. 1", method: "New PDF route", sameRouteAsExisting: null, sameAsPreviousVersion: true }],
							newSections: [{ title: "Extra PDF", pages: "p. 3" }],
						}),
					),
				]),
			],
			seen,
		);
		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_pdf",
			path: pdfFixture,
			targets: [{ id: "n1", title: "Node 1" }],
			existingMethods: {},
			previousMethods: { n1: { pages: "p. 1", method: "Old PDF route" } },
			abortSignal: new AbortController().signal,
		});
		assert.equal(outcome.ok, true);
		assert.ok(seen[0]?.includes("This file replaces an earlier version of the same course file."));
	});
});

describe("course-replace-assign post-replace non-replace updates", () => {
	it("preserves existing update.nodes and update.newSections on a later non-replace applyAssignment", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/v1.md", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [{ nodeId: "n1", path: "/course/v1.md", pages: "p. 1", method: "Old n1" }],
			conflicts: [],
		};
		const started = startReplacement(initial, "/course/v1.md", "/course/v2.md", "2026-11-24T12:00:00.000Z");
		const afterReplace = applyAssignment(
			started,
			"/course/v2.md",
			{
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 2", method: "Same n1", sameRouteAsExisting: null, sameAsPreviousVersion: true }],
				newSections: [{ title: "Bonus Section", pages: "p. 5" }],
			},
			["n1"],
		);
		assert.deepEqual(afterReplace.files[0]?.update?.nodes, [{ nodeId: "n1", kind: "same" }]);
		assert.deepEqual(afterReplace.files[0]?.update?.newSections, [{ title: "Bonus Section", pages: "p. 5" }]);

		// Subsequent non-replace assignment (e.g. plan_init adds node n2) must not clobber update classification.
		const afterPlanInit = applyAssignment(
			afterReplace,
			"/course/v2.md",
			{
				category: "material",
				nodes: [{ nodeId: "n2", pages: "p. 5", method: "New n2", sameRouteAsExisting: null }],
			},
			["n2"],
		);
		assert.deepEqual(afterPlanInit.files[0]?.update?.nodes, [{ nodeId: "n1", kind: "same" }]);
		assert.deepEqual(afterPlanInit.files[0]?.update?.newSections, [{ title: "Bonus Section", pages: "p. 5" }]);
		assert.equal(afterPlanInit.methods.length, 2);
	});
});
