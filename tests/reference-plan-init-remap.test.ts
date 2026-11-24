import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { PiEngine } from "../src/agent/models.ts";
import { createCourseAssignWorker } from "../src/agent/subagents/course-assign.ts";
import type { ChatRecord, JobRecord, PlanTree } from "../src/core/contracts.ts";
import type { CourseMaterial, ReferenceSection } from "../src/core/contracts/course.ts";
import { assignmentTargets } from "../src/core/course-assign.ts";
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

	return { chatStore, jobStore };
}

function makeChat(material: CourseMaterial, tree: PlanTree): ChatRecord {
	return {
		id: "chat_1",
		title: "Signals",
		createdAt: "2026-11-24T00:00:00.000Z",
		updatedAt: "2026-11-24T00:00:00.000Z",
		messages: [],
		tree,
		courseMaterial: material,
	};
}

describe("reference plan_init remap without reader call", () => {
	const storedSections: ReferenceSection[] = [
		{ id: "s1", title: "Chapter 1: Laplace", level: 1, startPage: 1, endPage: 20 },
		{ id: "s2", title: "Chapter 2: Z-Transform", level: 1, startPage: 21, endPage: 40 },
	];

	it("skips the reader call and goes straight to the pointer mapper when category is reference and referenceIndex is passed", async () => {
		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n2", sections: ["s2"] }] }))]),
		]);

		let calls = 0;
		const toolsPerCall: number[] = [];
		const systemPrompts: Array<string | undefined> = [];
		const origStream = engine.streamFn;
		engine.streamFn = (model, context, opts) => {
			calls++;
			toolsPerCall.push(getCurrentTools(context.messages).length);
			const lead = context.messages[0];
			systemPrompts.push(lead?.role === "system" ? (typeof lead.content === "string" ? lead.content : lead.content.map((c) => c.text).join("\n")) : undefined);
			return origStream(model, context, opts);
		};

		const worker = createCourseAssignWorker({ engineFor: () => engine });
		const outcome = await worker({
			chatId: "chat_1",
			path: "/nonexistent/textbook.pdf",
			targets: [{ id: "n2", title: "Z-Transform" }],
			existingMethods: {},
			category: "reference",
			referenceIndex: { from: "outline", sections: storedSections },
			abortSignal: new AbortController().signal,
		});

		assert.equal(calls, 1);
		assert.deepEqual(toolsPerCall, [0]);
		assert.ok(systemPrompts[0]?.includes("table of contents"));
		assert.equal(outcome.ok, true);
		if (!outcome.ok || outcome.result.category !== "reference") return;
		assert.deepEqual(outcome.result.nodes, [{ nodeId: "n2", sectionIds: ["s2"] }]);
		assert.equal(outcome.result.index, undefined);
	});

	it("re-maps changed nodes of a reader-sorted reference file from stored index on plan_init without running the reader", async () => {
		const prevTree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Laplace", summary: "Unchanged" },
				{ id: "n2", title: "Old Z", summary: "Old" },
			],
			edges: [],
			version: 1,
		};
		const nextTree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Laplace", summary: "Unchanged" },
				{ id: "n2", title: "Z-Transform", summary: "Updated" },
			],
			edges: [],
			version: 2,
		};
		const initialMaterial: CourseMaterial = {
			files: [
				{
					path: "/nonexistent/book.pdf",
					addedAt: "2026-11-24T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [{ path: "/nonexistent/book.pdf", from: "outline", sections: storedSections }],
			referencePointers: [{ nodeId: "n1", path: "/nonexistent/book.pdf", sectionIds: ["s1"] }],
		};

		const { targets, material } = assignmentTargets({
			kind: "plan_init",
			material: initialMaterial,
			previousTree: prevTree,
			nextTree,
		});
		assert.deepEqual(targets, [{ path: "/nonexistent/book.pdf", nodeIds: ["n2"] }]);

		const engine = makeFauxEngine([
			fauxAssistantMessage([fauxText(JSON.stringify({ nodes: [{ nodeId: "n2", sections: ["s2"] }] }))]),
		]);
		let calls = 0;
		const origStream = engine.streamFn;
		engine.streamFn = (model, context, opts) => {
			calls++;
			assert.equal(getCurrentTools(context.messages).length, 0);
			return origStream(model, context, opts);
		};

		const { chatStore, jobStore } = makeMemoryStores(makeChat(material, nextTree));
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: createCourseAssignWorker({ engineFor: () => engine }),
		});

		await queue.enqueue("chat_1", targets);

		assert.equal(calls, 1);
		const saved = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(saved?.files[0]?.status, "assigned");
		assert.equal(saved?.files[0]?.category, "reference");
		assert.equal(saved?.files[0]?.categoryBy, "reader");
		assert.deepEqual(saved?.referenceIndex, [{ path: "/nonexistent/book.pdf", from: "outline", sections: storedSections }]);
		assert.deepEqual(saved?.referencePointers, [
			{ nodeId: "n1", path: "/nonexistent/book.pdf", sectionIds: ["s1"] },
			{ nodeId: "n2", path: "/nonexistent/book.pdf", sectionIds: ["s2"] },
		]);
	});

	it("does not force category or pass referenceIndex for reader-sorted material files", async () => {
		const tree: PlanTree = {
			nodes: [{ id: "n1", title: "Laplace", summary: "s-plane" }],
			edges: [],
			version: 1,
		};
		const chat = makeChat(
			{
				files: [
					{
						path: "/course/notes.md",
						addedAt: "2026-11-24T00:00:00.000Z",
						via: "learner",
						binding: true,
						status: "assigned",
						category: "material",
						categoryBy: "reader",
					},
				],
				methods: [],
				conflicts: [],
				referenceIndex: [{ path: "/course/notes.md", from: "headings", sections: storedSections }],
			},
			tree,
		);
		const { chatStore, jobStore } = makeMemoryStores(chat);
		let seenCategory: unknown = "unset";
		let seenIndex: unknown = "unset";

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				seenCategory = input.category;
				seenIndex = input.referenceIndex;
				return { ok: true, result: { category: "material", nodes: [] } };
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/notes.md", nodeIds: ["n1"] }]);

		assert.equal(seenCategory, undefined);
		assert.equal(seenIndex, undefined);
	});
});
