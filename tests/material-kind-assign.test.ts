import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, CourseMaterial, JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import {
	COURSE_ASSIGN_INSTRUCTIONS,
	applyAssignment,
	parseAssignment,
} from "../src/core/course-assign.ts";
import { createCourseAssignQueue } from "../src/server/course-assign-queue.ts";

const CONFIRMED_INSTRUCTIONS_PARAGRAPH =
	'For material, also decide how complete it is. **complete**: it works the course\'s derivations and procedures through step by step, as a script, lecture notes or a transcript of the lecture (Mitschrift) do. **overview**: it shows what the course covers, its results and formulas, but mostly not the steps between them, as lecture slides usually do. Set "materialKind" to "complete" or "overview".';

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
	const jobStore: Pick<JobStore, "createJob" | "updateJob"> = {
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
	};
	return { chatStore, jobStore };
}

describe("COURSE_ASSIGN_INSTRUCTIONS materialKind", () => {
	// plan 020 part 2: material branch of COURSE_ASSIGN_INSTRUCTIONS gains the confirmed paragraph and materialKind in JSON
	it("includes the owner-confirmed materialKind paragraph and JSON shape", () => {
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes(CONFIRMED_INSTRUCTIONS_PARAGRAPH));
		assert.ok(COURSE_ASSIGN_INSTRUCTIONS.includes('"materialKind":"complete"|"overview"'));
	});
});

describe("parseAssignment materialKind", () => {
	const TARGETS = ["n1"];

	// plan 020 part 2: parseAssignment accepts materialKind "complete" and "overview" for material
	it("accepts complete and overview for material and preserves materialKind", () => {
		for (const materialKind of ["complete", "overview"] as const) {
			const parsed = parseAssignment(
				JSON.stringify({
					category: "material",
					materialKind,
					nodes: [{ nodeId: "n1", pages: "S. 1", method: "Step 1.", sameRouteAsExisting: null }],
				}),
				TARGETS,
			);
			assert.deepEqual(parsed, {
				ok: true,
				value: {
					category: "material",
					materialKind,
					nodes: [{ nodeId: "n1", pages: "S. 1", method: "Step 1.", sameRouteAsExisting: null }],
				},
			});
		}
	});

	// plan 020 part 2: missing or invalid materialKind is a problem, repaired like today's problems
	it("rejects missing or invalid materialKind for material", () => {
		for (const bad of [undefined, "", "slides", "script", "COMPLETE", 123, null, {}]) {
			const payload: Record<string, unknown> = {
				category: "material",
				nodes: [],
			};
			if (bad !== undefined) payload.materialKind = bad;
			const parsed = parseAssignment(JSON.stringify(payload), TARGETS);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 020 part 2: materialKind problem is collected alongside node problems
	it("collects materialKind problems together with node problems", () => {
		const parsed = parseAssignment(
			JSON.stringify({
				category: "material",
				materialKind: "slides",
				nodes: [{ nodeId: "bogus", pages: "p. 1", method: "Step.", sameRouteAsExisting: null }],
			}),
			TARGETS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length >= 2);
	});

	// plan 020 part 2: materialKind is required only for material, not exam or reference
	it("does not require materialKind for exam or reference", () => {
		const exam = parseAssignment(
			JSON.stringify({
				category: "exam",
				nodes: [{ nodeId: "n1", source: "WS22 A1", pages: "p. 1", pattern: "Compute X" }],
			}),
			TARGETS,
		);
		assert.equal(exam.ok, true);

		const ref = parseAssignment(JSON.stringify({ category: "reference", nodes: [] }), TARGETS);
		assert.equal(ref.ok, true);
	});
});

describe("applyAssignment materialKind", () => {
	// plan 020 part 2: applyAssignment stores materialKind with materialKindBy: "reader"
	it("stores materialKind with materialKindBy reader", () => {
		const initial: CourseMaterial = {
			files: [{ path: "/course/slides.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigning" }],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/slides.pdf", {
			category: "material",
			materialKind: "overview",
			nodes: [{ nodeId: "n1", pages: "p. 2", method: "Formula A.", sameRouteAsExisting: null }],
		});
		assert.equal(next.files[0]?.materialKind, "overview");
		assert.equal(next.files[0]?.materialKindBy, "reader");
	});

	// plan 020 part 2: reader label overwrites a previous reader label
	it("updates materialKind when previously set by reader", () => {
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigning",
					materialKind: "overview",
					materialKindBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/notes.pdf", {
			category: "material",
			materialKind: "complete",
			nodes: [],
		});
		assert.equal(next.files[0]?.materialKind, "complete");
		assert.equal(next.files[0]?.materialKindBy, "reader");
	});

	// plan 020 part 2: learner's materialKindBy: "learner" label stays even when reader disagrees
	it("keeps learner-set materialKind and materialKindBy learner while still applying nodes", () => {
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigning",
					materialKind: "overview",
					materialKindBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
		};
		const next = applyAssignment(initial, "/course/slides.pdf", {
			category: "material",
			materialKind: "complete",
			nodes: [{ nodeId: "n1", pages: "p. 1", method: "Kept method.", sameRouteAsExisting: null }],
		});
		assert.equal(next.files[0]?.materialKind, "overview");
		assert.equal(next.files[0]?.materialKindBy, "learner");
		assert.equal(next.files[0]?.status, "assigned");
		assert.equal(next.methods.length, 1);
	});
});

describe("course-assign-queue materialKind learner override logging", () => {
	// plan 020 part 2: when file has materialKindBy: "learner", learner's label stays and answer is logged like category
	it("logs a warning and keeps the learner label when reader answers a different materialKind", async () => {
		const chat: ChatRecord = {
			id: "chat_1",
			title: "Control",
			createdAt: "2026-11-25T00:00:00.000Z",
			updatedAt: "2026-11-25T00:00:00.000Z",
			messages: [],
			tree: { nodes: [{ id: "n1", title: "Node 1" }], edges: [], version: 1 },
			courseMaterial: {
				files: [
					{
						path: "/course/slides.pdf",
						addedAt: "2026-11-25T00:00:00.000Z",
						via: "learner",
						binding: true,
						status: "pending",
						materialKind: "overview",
						materialKindBy: "learner",
					},
				],
				methods: [],
				conflicts: [],
			},
		};
		const { chatStore, jobStore } = makeStores(chat);
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		try {
			const queue = createCourseAssignQueue({
				chatStore,
				jobStore,
				worker: async () => ({
					ok: true,
					result: {
						category: "material",
						materialKind: "complete",
						nodes: [{ nodeId: "n1", pages: "p. 1", method: "Method.", sameRouteAsExisting: null }],
					},
				}),
			});
			await queue.enqueue("chat_1", [{ path: "/course/slides.pdf", nodeIds: ["n1"] }]);
		} finally {
			console.warn = origWarn;
		}
		const saved = chatStore.getChat("chat_1")?.courseMaterial?.files[0];
		assert.equal(saved?.materialKind, "overview");
		assert.equal(saved?.materialKindBy, "learner");
		assert.ok(warnings.some((w) => w.includes("/course/slides.pdf") && w.includes("complete") && w.includes("overview")));
	});
});
