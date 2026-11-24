import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, JobRecord, PlanTree } from "../src/core/contracts.ts";
import { EXAM_PATTERN_CAP, type CourseMaterial } from "../src/core/contracts/course.ts";
import {
	COURSE_ASSIGN_INSTRUCTIONS,
	applyAssignment,
	buildAssignmentPrompt,
	parseAssignment,
} from "../src/core/course-assign.ts";
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

	return { chatStore, jobStore };
}

function makeChat(material: CourseMaterial, tree?: PlanTree): ChatRecord {
	return {
		id: "chat_1",
		title: "Control Systems",
		createdAt: "2026-11-23T00:00:00.000Z",
		updatedAt: "2026-11-23T00:00:00.000Z",
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

describe("COURSE_ASSIGN_INSTRUCTIONS", () => {
	// plan 010 part 2: COURSE_ASSIGN_INSTRUCTIONS gets a first paragraph and the exam branch
	it("describes exam vs material sorting and exam output fields", () => {
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("category"));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("material"));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("exam"));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("source"));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("pattern"));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes("grading"));
	});
});

describe("buildAssignmentPrompt (category lock)", () => {
	const TARGETS = [{ id: "n1", title: "Root locus" }];

	// plan 010 part 2: when categoryBy === "learner", the task line states "This file is a <category>; do not decide again."
	it("states the locked category when category is provided", () => {
		const examPrompt = buildAssignmentPrompt({ path: "/course/ws22.pdf", targets: TARGETS, category: "exam" });
		assert.ok(examPrompt.includes("This file is a exam; do not decide again."));

		const materialPrompt = buildAssignmentPrompt({ path: "/course/script.pdf", targets: TARGETS, category: "material" });
		assert.ok(materialPrompt.includes("This file is a material; do not decide again."));
	});

	// plan 010 part 2: when category is omitted, the prompt does not lock the category
	it("omits the category lock line when category is omitted", () => {
		const prompt = buildAssignmentPrompt({ path: "/course/ws22.pdf", targets: TARGETS });
		assert.equal(prompt.includes("do not decide again"), false);
	});
});

describe("parseAssignment (exam shape and category validation)", () => {
	const TARGETS = ["n1", "n2"];

	// plan 010 part 2: valid exam shape with source, pages, pattern, and optional grading
	it("parses a valid exam result with and without grading", () => {
		const raw = JSON.stringify({
			category: "exam",
			nodes: [
				{
					nodeId: "n1",
					source: "WS22 A3b",
					pages: "S. 2",
					pattern: "Compute poles of G(s); sketch root locus; 6 pts.",
					grading: "2 pts characteristic equation; 4 pts sketch.",
				},
				{
					nodeId: "n2",
					source: "WS22 A4",
					pages: "S. 3",
					pattern: "Determine gain margin from Bode plot; 4 pts.",
				},
			],
		});
		const parsed = parseAssignment(raw, TARGETS);
		assert.deepEqual(parsed, {
			ok: true,
			value: {
				category: "exam",
				nodes: [
					{
						nodeId: "n1",
						source: "WS22 A3b",
						pages: "S. 2",
						pattern: "Compute poles of G(s); sketch root locus; 6 pts.",
						grading: "2 pts characteristic equation; 4 pts sketch.",
					},
					{
						nodeId: "n2",
						source: "WS22 A4",
						pages: "S. 3",
						pattern: "Determine gain margin from Bode plot; 4 pts.",
					},
				],
			},
		});
	});

	// plan 010 part 2: one entry per task, so one node may carry several exam entries
	it("accepts several exam entries for the same node id", () => {
		const parsed = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [
					{ nodeId: "n1", source: "WS22 A1a", pages: "S. 1", pattern: "Pattern a" },
					{ nodeId: "n1", source: "WS22 A1b", pages: "S. 1", pattern: "Pattern b" },
				],
			}),
			TARGETS,
		);
		assert.equal(parsed.ok, true);
	});

	// plan 010 part 2: empty nodes array is valid for an exam
	it("accepts an empty nodes array for an exam", () => {
		const parsed = parseAssignment(JSON.stringify({ category: "exam", nodes: [] }), TARGETS);
		assert.deepEqual(parsed, { ok: true, value: { category: "exam", nodes: [] } });
	});

	// plan 010 part 2: missing category is reported as a problem
	it("rejects missing category", () => {
		const parsed = parseAssignment(JSON.stringify({ nodes: [] }), TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 010 part 2: unknown category is reported as a problem
	it("rejects unknown category", () => {
		const parsed = parseAssignment(JSON.stringify({ category: "slides", nodes: [] }), TARGETS);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 010 part 2: exam entry without source is reported as a problem
	it("rejects an exam entry without source or with whitespace-only source", () => {
		for (const entry of [
			{ nodeId: "n1", pages: "S. 1", pattern: "Compute X." },
			{ nodeId: "n1", source: "   ", pages: "S. 1", pattern: "Compute X." },
		]) {
			const parsed = parseAssignment(JSON.stringify({ category: "exam", nodes: [entry] }), TARGETS);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 010 part 2: exam entry without pattern is reported as a problem
	it("rejects an exam entry without pattern or with whitespace-only pattern", () => {
		for (const entry of [
			{ nodeId: "n1", source: "WS22 A1", pages: "S. 1" },
			{ nodeId: "n1", source: "WS22 A1", pages: "S. 1", pattern: "   " },
		]) {
			const parsed = parseAssignment(JSON.stringify({ category: "exam", nodes: [entry] }), TARGETS);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 010 part 2: exam pattern at EXAM_PATTERN_CAP (1,200) is valid; 1,201 chars is a problem
	it("accepts exam pattern at EXAM_PATTERN_CAP and rejects one over the cap", () => {
		const ok = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "x".repeat(EXAM_PATTERN_CAP) }],
			}),
			TARGETS,
		);
		assert.equal(ok.ok, true);

		const bad = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "x".repeat(EXAM_PATTERN_CAP + 1) }],
			}),
			TARGETS,
		);
		assert.equal(bad.ok, false);
		assert.ok(bad.problems.some((p) => p.includes("n1")));
	});

	// plan 010 part 2: exam grading at EXAM_PATTERN_CAP (1,200) is valid; 1,201 chars is a problem
	it("accepts exam grading at EXAM_PATTERN_CAP and rejects one over the cap", () => {
		const ok = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "Compute X.", grading: "g".repeat(EXAM_PATTERN_CAP) }],
			}),
			TARGETS,
		);
		assert.equal(ok.ok, true);

		const bad = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "Compute X.", grading: "g".repeat(EXAM_PATTERN_CAP + 1) }],
			}),
			TARGETS,
		);
		assert.equal(bad.ok, false);
		assert.ok(bad.problems.some((p) => p.includes("n1")));
	});

	// plan 010 part 2: unknown node id in exam shape is reported as a problem
	it("rejects an exam entry with an unknown node id", () => {
		const parsed = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "unknown-id", source: "A1", pages: "p. 1", pattern: "Compute X." }],
			}),
			TARGETS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("unknown-id")));
	});
});

describe("applyAssignment (exams and category handling)", () => {
	// plan 010 part 2: exam answer sets category to "exam", stores examPatterns, and adds no methods or conflicts
	it("stores examPatterns and sets category without adding methods or conflicts", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning" }],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/ws22.pdf", {
			category: "exam",
			nodes: [
				{ nodeId: "n1", source: "WS22 A3b", pages: "S. 2", pattern: "Pattern 1", grading: "Grading 1" },
				{ nodeId: "n2", source: "WS22 A4", pages: "S. 3", pattern: "Pattern 2" },
			],
		});
		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.files[0]?.category, "exam");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.methods, []);
		assert.deepEqual(next.conflicts, []);
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A3b", pages: "S. 2", pattern: "Pattern 1", grading: "Grading 1" },
			{ nodeId: "n2", path: "/course/ws22.pdf", source: "WS22 A4", pages: "S. 3", pattern: "Pattern 2" },
		]);
	});

	// plan 010 part 2: one entry per task, so two entries of one node (different sources) are both stored
	it("stores several exam entries that share a node id", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning" }],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/ws22.pdf", {
			category: "exam",
			nodes: [
				{ nodeId: "n1", source: "WS22 A1a", pages: "S. 1", pattern: "Pattern a" },
				{ nodeId: "n1", source: "WS22 A1b", pages: "S. 1", pattern: "Pattern b" },
			],
		});
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1a", pages: "S. 1", pattern: "Pattern a" },
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1b", pages: "S. 1", pattern: "Pattern b" },
		]);
	});

	// plan 010 part 2: exam answer replaces this file's old examPatterns on target nodes while preserving other files and non-target nodes
	it("replaces this file's old examPatterns on target nodes without touching other files or non-target nodes", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "reader" },
				{ path: "/course/ss22.pdf", addedAt: "2026-11-23T00:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam", categoryBy: "reader" },
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/ws22.pdf", source: "Old A1", pattern: "Old pattern" },
				{ nodeId: "n2", path: "/course/ws22.pdf", source: "Keep A2", pattern: "Keep pattern" },
				{ nodeId: "n1", path: "/course/ss22.pdf", source: "SS22 A1", pattern: "Other file pattern" },
			],
		};
		const next = applyAssignment(
			initial,
			"/course/ws22.pdf",
			{
				category: "exam",
				nodes: [{ nodeId: "n1", source: "New A1", pages: "p. 1", pattern: "New pattern" }],
			},
			["n1"],
		);
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n2", path: "/course/ws22.pdf", source: "Keep A2", pattern: "Keep pattern" },
			{ nodeId: "n1", path: "/course/ss22.pdf", source: "SS22 A1", pattern: "Other file pattern" },
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "New A1", pages: "p. 1", pattern: "New pattern" },
		]);
	});

	// plan 010 part 2: learner-set category is not overwritten by a different reader answer (answer's category is ignored)
	it("keeps learner-set category and categoryBy when reader answer returns a different category", () => {
		const examByLearner: CourseMaterial = {
			files: [
				{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "learner" },
			],
			methods: [],
			conflicts: [],
		};
		const nextExam = applyAssignment(examByLearner, "/course/ws22.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "Ignored method", sameRouteAsExisting: null }],
		});
		assert.equal(nextExam.files[0]?.category, "exam");
		assert.equal(nextExam.files[0]?.categoryBy, "learner");
		assert.equal(nextExam.files[0]?.status, "assigned");
		assert.deepEqual(nextExam.methods, []);

		const materialByLearner: CourseMaterial = {
			files: [
				{ path: "/course/notes.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "material", categoryBy: "learner" },
			],
			methods: [],
			conflicts: [],
		};
		const nextMaterial = applyAssignment(materialByLearner, "/course/notes.pdf", {
			category: "exam",
			nodes: [{ nodeId: "n1", source: "A1", pages: "p. 1", pattern: "Ignored pattern" }],
		});
		assert.equal(nextMaterial.files[0]?.category, "material");
		assert.equal(nextMaterial.files[0]?.categoryBy, "learner");
		assert.equal(nextMaterial.files[0]?.status, "assigned");
		assert.deepEqual(nextMaterial.examPatterns ?? [], []);
	});

	// plan 010 part 2: categoryBy stays "learner" when it was "learner" and reader agrees on "exam"
	it("keeps categoryBy as learner when reader also returns exam", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "learner" },
			],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/ws22.pdf", {
			category: "exam",
			nodes: [{ nodeId: "n1", source: "WS22 A1", pages: "p. 1", pattern: "Pattern 1" }],
		});
		assert.equal(next.files[0]?.category, "exam");
		assert.equal(next.files[0]?.categoryBy, "learner");
		assert.equal(next.examPatterns?.length, 1);
	});

	// plan 010 part 2: a material answer for a file the reader called exam before replaces its patterns with methods
	it("replaces old examPatterns with methods when a reader-categorized exam is reassigned as material", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/notes.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "reader" },
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/notes.pdf", source: "Task 1", pattern: "Old pattern" },
			],
		};
		const next = applyAssignment(initial, "/course/notes.pdf", {
			category: "material",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "New method", sameRouteAsExisting: null }],
		});
		assert.equal(next.files[0]?.category, "material");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.examPatterns ?? [], []);
		assert.deepEqual(next.methods, [
			{ nodeId: "n1", path: "/course/notes.pdf", pages: "p. 1", method: "New method" },
		]);
	});
});

describe("course-assign-queue (exam and learner category)", () => {
	// plan 010 part 2: learner-set category is passed in the task to the worker
	it("passes learner-set category to worker only when categoryBy is learner", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/locked.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "pending", category: "exam", categoryBy: "learner" },
				{ path: "/course/auto.pdf", addedAt: "2026-11-23T00:01:00.000Z", via: "learner", binding: true, status: "pending", category: "exam", categoryBy: "reader" },
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);
		const seenCategories = new Map<string, string | undefined>();

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async (input) => {
				seenCategories.set(input.path, input.category);
				return { ok: true, result: { category: "exam", nodes: [] } };
			},
		});

		await queue.enqueue("chat_1", [
			{ path: "/course/locked.pdf", nodeIds: ["n1"] },
			{ path: "/course/auto.pdf", nodeIds: ["n1"] },
		]);

		assert.equal(seenCategories.get("/course/locked.pdf"), "exam");
		assert.equal(seenCategories.get("/course/auto.pdf"), undefined);
	});

	// plan 010 part 2: a mismatched reader category on a learner-categorized file is a problem-free mismatch
	it("handles a mismatched reader category on a learner-categorized file without failing", async () => {
		const chat = makeChat({
			files: [
				{ path: "/course/locked.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "pending", category: "exam", categoryBy: "learner" },
			],
			methods: [],
			conflicts: [],
		});
		const { chatStore, jobStore } = makeMemoryStores(chat);

		const queue = createCourseAssignQueue({
			chatStore,
			jobStore,
			worker: async () => ({
				ok: true,
				result: {
					category: "material",
					nodes: [{ nodeId: "n1", pages: "p. 1", method: "Should be ignored", sameRouteAsExisting: null }],
				},
			}),
		});

		await queue.enqueue("chat_1", [{ path: "/course/locked.pdf", nodeIds: ["n1"] }]);

		const material = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[0]?.category, "exam");
		assert.equal(material?.files[0]?.categoryBy, "learner");
		assert.deepEqual(material?.methods, []);
		assert.equal(jobStore.all()[0]?.status, "done");
	});
});

describe("applyAssignment and course-assign-queue (exam flips and tree liveness)", () => {
	// plan 010 part 2: flipping exam -> material drops all examPatterns for the file, including non-target nodes
	it("drops all examPatterns for a file including non-target nodes when an exam flips to material", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/notes.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "reader" },
				{ path: "/course/other.pdf", addedAt: "2026-11-23T00:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam", categoryBy: "reader" },
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "n1", path: "/course/notes.pdf", source: "Task 1", pattern: "Old n1" },
				{ nodeId: "n2", path: "/course/notes.pdf", source: "Task 2", pattern: "Old n2" },
				{ nodeId: "n2", path: "/course/other.pdf", source: "Other 2", pattern: "Keep other" },
			],
		};
		const next = applyAssignment(
			initial,
			"/course/notes.pdf",
			{
				category: "material",
				nodes: [{ nodeId: "n1", pages: "p. 1", method: "New method", sameRouteAsExisting: null }],
			},
			["n1"],
		);
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n2", path: "/course/other.pdf", source: "Other 2", pattern: "Keep other" },
		]);
		assert.deepEqual(next.methods, [
			{ nodeId: "n1", path: "/course/notes.pdf", pages: "p. 1", method: "New method" },
		]);
	});

	// plan 010 part 2: flipping material -> exam removes the file's methods and strips it from conflicts
	it("drops methods and removes the file from conflicts when a material file flips to exam", () => {
		const initial: CourseMaterial = {
			files: [
				{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "material", categoryBy: "reader" },
				{ path: "/course/script.pdf", addedAt: "2026-11-23T00:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", categoryBy: "reader" },
				{ path: "/course/notes.pdf", addedAt: "2026-11-23T00:02:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", categoryBy: "reader" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/ws22.pdf", pages: "p. 1", method: "Old method" },
				{ nodeId: "n2", path: "/course/ws22.pdf", pages: "p. 2", method: "Old method 2" },
				{ nodeId: "n1", path: "/course/script.pdf", pages: "p. 5", method: "Keep script" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/ws22.pdf", "/course/script.pdf"], chosen: "/course/ws22.pdf" },
				{ nodeId: "n2", paths: ["/course/script.pdf", "/course/notes.pdf"] },
				{ nodeId: "n3", paths: ["/course/ws22.pdf", "/course/script.pdf", "/course/notes.pdf"], chosen: "/course/ws22.pdf" },
				{ nodeId: "n4", paths: ["/course/ws22.pdf", "/course/script.pdf", "/course/notes.pdf"], chosen: "/course/script.pdf" },
			],
		};
		const next = applyAssignment(
			initial,
			"/course/ws22.pdf",
			{
				category: "exam",
				nodes: [{ nodeId: "n1", source: "WS22 A1", pages: "S. 1", pattern: "Pattern 1" }],
			},
			["n1"],
		);
		assert.equal(next.files[0]?.category, "exam");
		assert.equal(next.files[0]?.categoryBy, "reader");
		assert.deepEqual(next.methods, [
			{ nodeId: "n1", path: "/course/script.pdf", pages: "p. 5", method: "Keep script" },
		]);
		assert.deepEqual(next.conflicts, [
			{ nodeId: "n2", paths: ["/course/script.pdf", "/course/notes.pdf"] },
			{ nodeId: "n3", paths: ["/course/script.pdf", "/course/notes.pdf"] },
			{ nodeId: "n4", paths: ["/course/script.pdf", "/course/notes.pdf"], chosen: "/course/script.pdf" },
		]);
		assert.deepEqual(next.examPatterns, [
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pages: "S. 1", pattern: "Pattern 1" },
		]);
	});

	// plan 010 part 2: exam assignments filter out nodes removed from the live tree while the worker ran
	it("filters out nodes removed from the chat tree while an exam worker is running", async () => {
		const initialChat: ChatRecord = {
			id: "chat_1",
			title: "Control Systems",
			createdAt: "2026-11-23T00:00:00.000Z",
			updatedAt: "2026-11-23T00:00:00.000Z",
			messages: [],
			tree: {
				nodes: [
					{ id: "n1", title: "Node 1", summary: "First" },
					{ id: "n2", title: "Node 2", summary: "Second" },
				],
				edges: [],
				version: 1,
			},
			courseMaterial: {
				files: [{ path: "/course/ws22.pdf", addedAt: "2026-11-23T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
				methods: [],
				conflicts: [],
			},
		};
		const chats = new Map<string, ChatRecord>([[initialChat.id, initialChat]]);
		const jobs = new Map<string, JobRecord>();
		let seq = 0;
		const chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial"> = {
			getChat: (id) => chats.get(id) ?? null,
			setCourseMaterial: (chatId, material) => {
				const existing = chats.get(chatId);
				if (!existing) throw new Error(`Chat not found: ${chatId}`);
				chats.set(chatId, { ...existing, courseMaterial: material });
			},
		};
		const jobStore: Pick<JobStore, "createJob" | "updateJob"> = {
			createJob: (init: CreateJobInit) => {
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
			updateJob: (id: string, patch: JobPatch) => {
				const existing = jobs.get(id);
				if (!existing) return null;
				const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
				jobs.set(id, next);
				return next;
			},
		};

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
						category: "exam",
						nodes: [
							{ nodeId: "n1", source: "WS22 A1", pages: "S. 1", pattern: "Keep n1" },
							{ nodeId: "n2", source: "WS22 A2", pages: "S. 2", pattern: "Removed n2" },
						],
					},
				};
			},
		});

		await queue.enqueue("chat_1", [{ path: "/course/ws22.pdf", nodeIds: ["n1", "n2"] }]);

		const material = chatStore.getChat("chat_1")?.courseMaterial;
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[0]?.category, "exam");
		assert.deepEqual(material?.examPatterns, [
			{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pages: "S. 1", pattern: "Keep n1" },
		]);
	});
});
