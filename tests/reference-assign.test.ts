import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { PiEngine } from "../src/agent/models.ts";
import { createCourseAssignWorker } from "../src/agent/subagents/course-assign.ts";
import type { ChatRecord, JobRecord, PlanTree } from "../src/core/contracts.ts";
import type { CourseMaterial, ReferenceSection } from "../src/core/contracts/course.ts";
import { applyAssignment, assignmentTargets } from "../src/core/course-assign.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { createCourseAssignQueue } from "../src/server/course-assign-queue.ts";

function makeFauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

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
		title: "Signals",
		createdAt: "2026-11-24T00:00:00.000Z",
		updatedAt: "2026-11-24T00:00:00.000Z",
		messages: [],
		tree: tree ?? {
			nodes: [
				{ id: "n1", title: "Laplace", summary: "s-plane" },
				{ id: "n2", title: "Fourier", summary: "Frequency domain" },
			],
			edges: [],
			version: 1,
		},
		courseMaterial: material,
	};
}

describe("applyAssignment (reference category)", () => {
	const sampleSections: ReferenceSection[] = [
		{ id: "s1", title: "Chapter 1", level: 1, startPage: 1, endPage: 10 },
	];

	// plan 012 part 3: store referencePointers for the targets; status assigned; no methods, no conflicts, no exam patterns
	it("stores referencePointers and referenceIndex and sets status assigned without methods, conflicts, or examPatterns", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/book.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning" }],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/book.pdf", {
			category: "reference",
			nodes: [{ nodeId: "n1", sectionIds: ["s1"] }],
			index: { from: "outline", sections: sampleSections },
		});
		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.category, "reference");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.methods, []);
		assert.deepEqual(next.conflicts, []);
		assert.deepEqual(next.examPatterns ?? [], []);
		assert.deepEqual(next.referenceIndex, [{ path: "/course/book.pdf", from: "outline", sections: sampleSections }]);
		assert.deepEqual(next.referencePointers, [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }]);
	});

	// plan 012 part 3: replaces this file's pointers on target nodes while preserving other files and non-target nodes
	it("replaces this file's pointers on target nodes without touching other files or non-target nodes", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/book1.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "reference", categoryBy: "reader" },
				{ path: "/course/book2.pdf", addedAt: "2026-11-24T00:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference", categoryBy: "reader" },
			],
			methods: [],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book1.pdf", sectionIds: ["s1"] },
				{ nodeId: "n2", path: "/course/book1.pdf", sectionIds: ["s2"] },
				{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s9"] },
			],
		};
		const next = applyAssignment(
			initial,
			"/course/book1.pdf",
			{ category: "reference", nodes: [{ nodeId: "n1", sectionIds: ["s3"] }] },
			["n1"],
		);
		assert.deepEqual(next.referencePointers, [
			{ nodeId: "n2", path: "/course/book1.pdf", sectionIds: ["s2"] },
			{ nodeId: "n1", path: "/course/book2.pdf", sectionIds: ["s9"] },
			{ nodeId: "n1", path: "/course/book1.pdf", sectionIds: ["s3"] },
		]);
	});

	// plan 012 part 3: learner-set reference category wins over a different reader category
	it("preserves learner-set reference category when reader returns another category", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/book.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "reference", categoryBy: "learner" }],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/book.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "Ignored", sameRouteAsExisting: null }],
		});
		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.category, "reference");
		assert.equal(next.files[0]?.categoryBy, "learner");
		assert.deepEqual(next.methods, []);
	});

	// plan 012 part 3: flipping material or exam to reference removes old methods, conflicts, and examPatterns
	it("drops old methods, conflicts, and examPatterns when a file flips to reference", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/book.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "material", categoryBy: "reader" },
				{ path: "/course/notes.pdf", addedAt: "2026-11-24T00:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", categoryBy: "reader" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/book.pdf", method: "Old method" },
				{ nodeId: "n1", path: "/course/notes.pdf", method: "Keep method" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/book.pdf", "/course/notes.pdf"], chosen: "/course/book.pdf" },
			],
			examPatterns: [
				{ nodeId: "n1", path: "/course/book.pdf", source: "A1", pattern: "Old pattern" },
			],
		};
		const next = applyAssignment(initial, "/course/book.pdf", {
			category: "reference",
			nodes: [{ nodeId: "n1", sectionIds: ["s1"] }],
			index: { from: "outline", sections: sampleSections },
		});
		assert.deepEqual(next.methods, [{ nodeId: "n1", path: "/course/notes.pdf", method: "Keep method" }]);
		assert.deepEqual(next.conflicts, []);
		assert.deepEqual(next.examPatterns, []);
		assert.deepEqual(next.referencePointers, [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }]);
	});
});

describe("assignmentTargets (reference pointers)", () => {
	// plan 012 part 3: plan_init drops referencePointers for nodes removed from the tree
	it("removes referencePointers for dropped nodes on plan_init", () => {
		const material: CourseMaterial = {
			files: [{ path: "/course/book.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference", categoryBy: "reader" }],
			methods: [],
			conflicts: [],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
				{ nodeId: "dropped", path: "/course/book.pdf", sectionIds: ["s2"] },
			],
		};
		const prev: PlanTree = {
			nodes: [
				{ id: "n1", title: "Keep" },
				{ id: "dropped", title: "Dropped" },
			],
			edges: [],
			version: 1,
		};
		const next: PlanTree = {
			nodes: [{ id: "n1", title: "Keep" }],
			edges: [],
			version: 2,
		};
		const res = assignmentTargets({ kind: "plan_init", material, previousTree: prev, nextTree: next });
		assert.deepEqual(res.material.referencePointers, [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }]);
		assert.deepEqual(res.targets, []);
	});

	// plan 012 part 3: plan_init targets changed and new nodes only for an assigned reference file
	it("targets only changed and new nodes for an assigned reference file on plan_init", () => {
		const material: CourseMaterial = {
			files: [{ path: "/course/book.pdf", addedAt: "2026-11-24T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference", categoryBy: "reader" }],
			methods: [],
			conflicts: [],
		};
		const prev: PlanTree = {
			nodes: [
				{ id: "n1", title: "Same", summary: "Same" },
				{ id: "n2", title: "Old", summary: "Same" },
			],
			edges: [],
			version: 1,
		};
		const next: PlanTree = {
			nodes: [
				{ id: "n1", title: "Same", summary: "Same" },
				{ id: "n2", title: "New", summary: "Same" },
				{ id: "n3", title: "Added" },
			],
			edges: [],
			version: 2,
		};
		const res = assignmentTargets({ kind: "plan_init", material, previousTree: prev, nextTree: next });
		assert.deepEqual(res.targets, [{ path: "/course/book.pdf", nodeIds: ["n2", "n3"] }]);
	});
});

describe("createCourseAssignWorker (reference sorting and pointer mapping)", () => {
	let tmpDir = "";

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ref-assign-"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// plan 012 part 3: on reference result, builds index if missing and runs one no-tools pointer-mapper call
	it("builds TOC index when missing and runs one no-tools pointer-mapper call", async () => {
		const file = path.join(tmpDir, "textbook.md");
		fs.writeFileSync(file, "# Chapter 1: Laplace\nContent\n# Chapter 2: Fourier\nMore\n");

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(JSON.stringify({ category: "reference", nodes: [] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s1"] }] }))]),
		]);

		let mapperToolsCount: number | undefined;
		const origStream = engine.streamFn;
		let callCount = 0;
		engine.streamFn = (model, context, opts) => {
			callCount++;
			if (callCount === 3) {
				mapperToolsCount = getCurrentTools(context.messages).length;
			}
			return origStream(model, context, opts);
		};

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: file,
			targets: [{ id: "n1", title: "Laplace" }],
			existingMethods: {},
			abortSignal: new AbortController().signal,
		});

		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(mapperToolsCount, 0);
		assert.equal(outcome.result.category, "reference");
		if (outcome.result.category !== "reference") return;
		assert.deepEqual(outcome.result.nodes, [{ nodeId: "n1", sectionIds: ["s1"] }]);
		assert.equal(outcome.result.index?.from, "headings");
		assert.equal(outcome.result.index?.sections.length, 2);
	});

	// plan 012 part 3: pointer mapper gets one repair attempt on invalid output
	it("gives the pointer mapper one repair attempt on invalid output", async () => {
		const file = path.join(tmpDir, "textbook-repair.md");
		fs.writeFileSync(file, "# Chapter 1: Laplace\nContent\n");

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(JSON.stringify({ category: "reference", nodes: [] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s999"] }] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s1"] }] }))]),
		]);

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: file,
			targets: [{ id: "n1", title: "Laplace" }],
			existingMethods: {},
			abortSignal: new AbortController().signal,
		});

		assert.equal(outcome.ok, true);
		if (!outcome.ok || outcome.result.category !== "reference") return;
		assert.deepEqual(outcome.result.nodes, [{ nodeId: "n1", sectionIds: ["s1"] }]);
	});

	// plan 012 part 3: pointer mapper fails after exhausting its one repair attempt
	it("fails after exhausting the one pointer-mapper repair attempt", async () => {
		const file = path.join(tmpDir, "textbook-fail.md");
		fs.writeFileSync(file, "# Chapter 1: Laplace\nContent\n");

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(JSON.stringify({ category: "reference", nodes: [] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s999"] }] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s888"] }] }))]),
		]);

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: file,
			targets: [{ id: "n1", title: "Laplace" }],
			existingMethods: {},
			abortSignal: new AbortController().signal,
		});

		assert.equal(outcome.ok, false);
	});

	// plan 012 part 3: re-maps from stored referenceIndex without re-extracting
	it("re-maps from stored referenceIndex without re-extracting", async () => {
		const file = path.join(tmpDir, "textbook-stored.md");
		fs.writeFileSync(file, "# Different Heading\nContent\n");

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(JSON.stringify({ category: "reference", nodes: [] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s_stored"] }] }))]),
		]);

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: file,
			targets: [{ id: "n1", title: "Laplace" }],
			existingMethods: {},
			referenceIndex: {
				from: "headings",
				sections: [{ id: "s_stored", title: "Stored Section", level: 1, startPage: 1, endPage: 2 }],
			},
			abortSignal: new AbortController().signal,
		});

		assert.equal(outcome.ok, true);
		if (!outcome.ok || outcome.result.category !== "reference") return;
		assert.deepEqual(outcome.result.nodes, [{ nodeId: "n1", sectionIds: ["s_stored"] }]);
	});

	// plan 012 part 3: text reader receives read_chunk tool while pointer mapper receives no tools
	it("passes the read_chunk tool to the text reader before the no-tools pointer mapper", async () => {
		const file = path.join(tmpDir, "textbook-tools.md");
		fs.writeFileSync(file, "# Chapter 1: Laplace\nContent\n");

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(JSON.stringify({ category: "reference", nodes: [] }))]),
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s1"] }] }))]),
		]);

		const toolsByCall: string[][] = [];
		const origStream = engine.streamFn;
		engine.streamFn = (model, context, opts) => {
			toolsByCall.push(getCurrentTools(context.messages).map((t) => t.name));
			return origStream(model, context, opts);
		};

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: file,
			targets: [{ id: "n1", title: "Laplace" }],
			existingMethods: {},
			abortSignal: new AbortController().signal,
		});

		assert.equal(outcome.ok, true);
		assert.deepEqual(toolsByCall, [["read_chunk"], ["read_chunk"], []]);
	});
});

describe("createCourseAssignQueue (reference files)", () => {
	// plan 012 part 3: queue passes learner-set reference category and stored referenceIndex, filters removed nodes, and stores referencePointers
	it("passes learner-set reference category and stored referenceIndex, filters removed nodes, and saves pointers", async () => {
		const storedSections: ReferenceSection[] = [
			{ id: "s1", title: "Chapter 1", level: 1, startPage: 1, endPage: 10 },
		];
		const chat = makeChat({
			files: [
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					category: "reference",
					categoryBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [{ path: "/course/book.pdf", from: "outline", sections: storedSections }],
		});
		const { chatStore, jobStore, chats } = makeMemoryStores(chat);
		let seenCategory: string | undefined;
		let seenIndex: unknown;

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				seenCategory = input.category;
				seenIndex = input.referenceIndex;
				const current = chats.get("chat_1");
				assert.ok(current);
				chats.set("chat_1", {
					...current,
					tree: {
						nodes: [{ id: "n1", title: "Laplace", summary: "s-plane" }],
						edges: [],
						version: 2,
					},
				});
				return {
					ok: true,
					result: {
						category: "reference",
						nodes: [
							{ nodeId: "n1", sectionIds: ["s1"] },
							{ nodeId: "n2", sectionIds: ["s1"] },
						],
					},
				};
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/book.pdf", nodeIds: ["n1", "n2"] }]);

		assert.equal(seenCategory, "reference");
		assert.deepEqual(seenIndex, { from: "outline", sections: storedSections });
		const material = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[0]?.category, "reference");
		assert.deepEqual(material?.referencePointers, [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] }]);
		assert.equal(jobStore.all()[0]?.activity, "assigned");
	});
});
