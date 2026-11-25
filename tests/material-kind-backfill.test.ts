import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import type { ChatRecord, CourseMaterial, JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import {
	applyMaterialKind,
	labelTargets,
	parseMaterialKind,
} from "../src/core/course-assign.ts";
import {
	COURSE_LABEL_TASK,
	createCourseLabelWorker,
} from "../src/agent/subagents/course-assign.ts";
import { createCourseAssignQueue } from "../src/server/course-assign-queue.ts";
import { createMaterialKindBackfill } from "../src/server/chat-handler.ts";

const CONFIRMED_LABEL_TASK =
	'Decide only how complete this course file is; do not read it against a plan. Look at its size and at a few pages spread through the file. **complete**: it works the course\'s derivations and procedures through step by step, as a script, lecture notes or a transcript of the lecture (Mitschrift) do. **overview**: it shows what the course covers, its results and formulas, but mostly not the steps between them, as lecture slides usually do. Return ONE JSON object and nothing else: {"materialKind":"complete"|"overview"}.';

function makeStores(chat: ChatRecord) {
	const chats = new Map<string, ChatRecord>([[chat.id, chat]]);
	const jobs = new Map<string, JobRecord>();
	let seq = 0;
	const chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial"> = {
		getChat: (id) => chats.get(id) ?? null,
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
		all: () => [...jobs.values()],
	};
	return { chatStore, jobStore, chats };
}

function makeChat(material: CourseMaterial): ChatRecord {
	return {
		id: "chat_1",
		title: "Control",
		createdAt: "2026-11-25T00:00:00.000Z",
		updatedAt: "2026-11-25T00:00:00.000Z",
		messages: [],
		tree: { nodes: [{ id: "n1", title: "Node 1" }], edges: [], version: 1 },
		courseMaterial: material,
	};
}

function fakeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function doneMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("labelTargets", () => {
	// plan 020 part 2: selects only binding material files with status assigned and no materialKind
	it("selects binding assigned material files missing materialKind and skips all others", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/c/needs-label-implicit.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/c/needs-label-explicit.md", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" },
				{ path: "/c/already-labeled.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", materialKind: "complete", materialKindBy: "reader" },
				{ path: "/c/unticked.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: false, status: "assigned" },
				{ path: "/c/pending.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/c/assigning.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
				{ path: "/c/failed.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "failed" },
				{ path: "/c/not-assignable.png", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				{ path: "/c/exam.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
				{ path: "/c/ref.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
		};
		assert.deepEqual(labelTargets(material), ["/c/needs-label-implicit.pdf", "/c/needs-label-explicit.md"]);
	});

	// plan 020 part 2: empty files list produces no label targets
	it("returns an empty array for empty files", () => {
		assert.deepEqual(labelTargets({ files: [], methods: [], conflicts: [] }), []);
	});
});

describe("parseMaterialKind", () => {
	// plan 020 part 2: parses {"materialKind":"complete"|"overview"}
	it("parses complete and overview including fenced JSON", () => {
		assert.deepEqual(parseMaterialKind('{"materialKind":"complete"}'), { ok: true, materialKind: "complete" });
		assert.deepEqual(parseMaterialKind('```json\n{"materialKind":"overview"}\n```'), { ok: true, materialKind: "overview" });
	});

	// plan 020 part 2: rejects invalid JSON, non-object, missing or invalid materialKind
	it("rejects invalid JSON or invalid materialKind values", () => {
		for (const bad of ["not json", "[]", "{}", '{"materialKind":"slides"}', '{"materialKind":""}', '{"materialKind":123}', '{"materialKind":null}']) {
			const parsed = parseMaterialKind(bad);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});
});

describe("applyMaterialKind", () => {
	// plan 020 part 2: stores materialKind with materialKindBy: "reader" unless learner set it
	it("stores reader label and preserves learner label", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/c/a.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/c/b.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", materialKind: "overview", materialKindBy: "learner" },
			],
			methods: [{ nodeId: "n1", path: "/c/a.pdf", method: "Step." }],
			conflicts: [],
		};
		const afterA = applyMaterialKind(material, "/c/a.pdf", "complete");
		assert.equal(afterA.files[0]?.materialKind, "complete");
		assert.equal(afterA.files[0]?.materialKindBy, "reader");
		assert.deepEqual(afterA.methods, material.methods);

		const afterB = applyMaterialKind(afterA, "/c/b.pdf", "complete");
		assert.equal(afterB.files[1]?.materialKind, "overview");
		assert.equal(afterB.files[1]?.materialKindBy, "learner");
	});
});

describe("COURSE_LABEL_TASK and createCourseLabelWorker", () => {
	// plan 020 part 2: label task matches confirmed text verbatim
	it("uses the owner-confirmed label task text verbatim", () => {
		assert.equal(COURSE_LABEL_TASK, CONFIRMED_LABEL_TASK);
	});

	// plan 020 part 2: text reader runs with label task, parses JSON, performs one repair attempt
	it("labels a text file and repairs once on invalid first output", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-label-"));
		const filePath = path.join(dir, "slides.md");
		fs.writeFileSync(filePath, "# Topic 1\nFormula: E = mc^2\n", "utf8");
		try {
			const replies = ["not valid json", '{"materialKind":"overview"}'];
			let calls = 0;
			const worker = createCourseLabelWorker({
				engineFor: () => ({
					model: fakeModel(),
					streamFn: (() => {
						const stream = createAssistantMessageEventStream();
						const text = replies[calls++] ?? "";
						queueMicrotask(() => {
							const msg = doneMessage(text);
							stream.push({ type: "done", reason: "stop", message: msg });
						});
						return stream;
					}) as never,
				}),
			});
			const res = await worker({ chatId: "chat_1", path: filePath, abortSignal: new AbortController().signal });
			assert.deepEqual(res, { ok: true, materialKind: "overview" });
			assert.equal(calls, 2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// plan 020 part 2: stops after one repair attempt when both attempts fail
	it("fails after one repair attempt when both responses are invalid", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-label-fail-"));
		const filePath = path.join(dir, "notes.txt");
		fs.writeFileSync(filePath, "Some text\n", "utf8");
		try {
			let calls = 0;
			const worker = createCourseLabelWorker({
				engineFor: () => ({
					model: fakeModel(),
					streamFn: (() => {
						calls++;
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							stream.push({ type: "done", reason: "stop", message: doneMessage('{"materialKind":"slides"}') });
						});
						return stream;
					}) as never,
				}),
			});
			const res = await worker({ chatId: "chat_1", path: filePath, abortSignal: new AbortController().signal });
			assert.equal(res.ok, false);
			assert.equal(calls, 2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// plan 020 part 2: missing engine returns failure cleanly
	it("returns ok: false when no engine is configured", async () => {
		const worker = createCourseLabelWorker({ engineFor: () => undefined });
		const res = await worker({ chatId: "chat_1", path: "/c/a.pdf", abortSignal: new AbortController().signal });
		assert.equal(res.ok, false);
	});
});

describe("course-assign-queue enqueueLabel", () => {
	// plan 020 part 2: activity dock label for a label job is "Checking <file name>", stores materialKindBy: "reader"
	it("creates a job with activity 'Checking <file name>' and stores materialKindBy reader on success", async () => {
		const chat = makeChat({
			files: [{ path: "/course/dir/slides.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeStores(chat);
		const emitted: string[] = [];
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "complete", nodes: [] } }),
			labelWorker: async () => ({ ok: true, materialKind: "overview" }),
			emit: (type, payload) => emitted.push(`${type}:${payload.chatId}`),
		});

		await queue.enqueueLabel("chat_1", ["/course/dir/slides.pdf"]);

		const job = jobStore.all()[0];
		assert.equal(job?.activity, "Checking slides.pdf");
		assert.equal(job?.status, "done");
		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(file?.status, "assigned");
		assert.equal(file?.materialKind, "overview");
		assert.equal(file?.materialKindBy, "reader");
		assert.equal(emitted.length, 1);
	});

	// plan 020 part 2: failed label job leaves materialKind absent and logs
	it("leaves materialKind absent and keeps status assigned when label job fails", async () => {
		const chat = makeChat({
			files: [{ path: "/course/slides.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeStores(chat);
		const logs: string[] = [];
		const origError = console.error;
		const origWarn = console.warn;
		console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
		console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
		try {
			const queue = createCourseAssignQueue({
				chatStore,
				jobStore,
				worker: async () => ({ ok: true, result: { category: "material", materialKind: "complete", nodes: [] } }),
				labelWorker: async () => ({ ok: false, error: "parse failed" }),
			});
			await queue.enqueueLabel("chat_1", ["/course/slides.pdf"]);
		} finally {
			console.error = origError;
			console.warn = origWarn;
		}
		const file = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(file?.status, "assigned");
		assert.equal(file?.materialKind, undefined);
		assert.equal(file?.materialKindBy, undefined);
		assert.equal(jobStore.all()[0]?.status, "error");
		assert.ok(logs.length > 0);
	});
});

describe("label PDF run and relabel guard", () => {
	// plan 020 part 2: the pdf-reader runs with the label task appended to its instructions
	it("runs the PDF reader with the label task in its system prompt", async () => {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText('{"materialKind":"overview"}')]),
		]);
		let systemPrompt = "";
		const worker = createCourseLabelWorker({
			engineFor: () => ({
				model: faux.getModel(),
				streamFn: (...args: Parameters<typeof faux.streamSimple>) => {
					systemPrompt ||= JSON.stringify(args[1]);
					return faux.streamSimple(...args);
				},
			}),
		});
		const fixture = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
		const res = await worker({ chatId: "chat_1", path: fixture, abortSignal: new AbortController().signal });
		assert.deepEqual(res, { ok: true, materialKind: "overview" });
		assert.ok(systemPrompt.includes("Decide only how complete this course file is; do not read it against a plan."));
	});

	// plan 020 part 2: a file that already has a label is not relabelled by the reader
	it("does not run the label worker for an already labelled file", async () => {
		const chat = makeChat({
			files: [{ path: "/course/a.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", materialKind: "complete", materialKindBy: "learner" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeStores(chat);
		let calls = 0;
		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({ ok: true, result: { category: "material", materialKind: "complete", nodes: [] } }),
			labelWorker: async () => {
				calls++;
				return { ok: true, materialKind: "overview" };
			},
		});
		await queue.enqueueLabel("chat_1", ["/course/a.pdf"]);
		assert.equal(calls, 0);
		assert.equal(jobStore.all().length, 0);
		assert.equal(chatStore.getChat("chat_1")?.courseMaterial?.files[0]?.materialKind, "complete");
	});
});

describe("createMaterialKindBackfill", () => {
	// plan 020 part 2: failed label job is retried on the next turn at most once per app run per file
	it("queues missing files and retries a failed file on the next turn at most once per app run", async () => {
		const chat = makeChat({
			files: [{ path: "/course/slides.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});
		const { chatStore } = makeStores(chat);
		const queued: string[][] = [];
		const backfill = createMaterialKindBackfill({
			chatStore,
			enqueueLabel: async (_chatId, paths) => {
				queued.push([...paths]);
			},
		});

		backfill("chat_1");
		await Promise.resolve();
		backfill("chat_1");
		await Promise.resolve();
		backfill("chat_1");
		await Promise.resolve();

		assert.deepEqual(queued, [["/course/slides.pdf"], ["/course/slides.pdf"]]);
	});

	// plan 020 part 2: the retry limit is per file, so an exhausted file does not stop a new file from being queued
	it("counts the retry limit per file, not per chat", async () => {
		const file = (p: string) => ({ path: p, addedAt: "2026-11-25T00:00:00.000Z", via: "learner" as const, binding: true, status: "assigned" as const });
		const chat = makeChat({ files: [file("/course/a.pdf")], methods: [], conflicts: [] });
		const { chatStore } = makeStores(chat);
		const queued: string[][] = [];
		const backfill = createMaterialKindBackfill({
			chatStore,
			enqueueLabel: async (_chatId, paths) => {
				queued.push([...paths]);
			},
		});

		for (let i = 0; i < 3; i++) {
			backfill("chat_1");
			await Promise.resolve();
		}
		assert.deepEqual(queued, [["/course/a.pdf"], ["/course/a.pdf"]]);

		chatStore.setCourseMaterial("chat_1", {
			files: [file("/course/a.pdf"), file("/course/b.pdf")],
			methods: [],
			conflicts: [],
		});
		backfill("chat_1");
		await Promise.resolve();
		assert.deepEqual(queued[2], ["/course/b.pdf"]);
	});
});
