import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { LhMarkerMessage, LhMessage } from "../src/core/index.ts";
import type { CompactionDeps } from "../src/server/compaction.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-notes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { ensureCompacted } = await import("../src/server/compaction.ts");
const { runUnitCut } = await import("../src/server/unit-cut.ts");
const { courseNotesFor } = await import("../src/core/course-notes.ts");
const { newMessageId, newUserMessage } = await import("../src/core/index.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function makeTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
			{ id: "n3", title: "Node 3" },
		],
		edges: [
			{ from: "n1", to: "n2" },
			{ from: "n2", to: "n3" },
		],
		units: [
			{ id: "u1", title: "Unit 1", nodeIds: ["n1", "n2"] },
			{ id: "u2", title: "Unit 2", nodeIds: ["n3"] },
		],
		version: 1,
	};
}

function makeMaterial(): CourseMaterial {
	return {
		files: [
			{ path: "/course/notes.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			{ path: "/course/ref.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
		],
		methods: [
			{ nodeId: "n1", path: "/course/notes.pdf", pages: "p. 1", method: "Method 1" },
			{ nodeId: "n2", path: "/course/notes.pdf", pages: "p. 2", method: "Method 2" },
			{ nodeId: "n3", path: "/course/notes.pdf", pages: "p. 3", method: "Method 3" },
		],
		conflicts: [],
		referenceIndex: [
			{
				path: "/course/ref.pdf",
				from: "contents",
				sections: [
					{ id: "1", title: "Sec 1", level: 1, startPage: 10, endPage: 15 },
					{ id: "2", title: "Sec 2", level: 1, startPage: 16, endPage: 20 },
				],
			},
		],
		referencePointers: [
			{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["1"] },
			{ nodeId: "n3", path: "/course/ref.pdf", sectionIds: ["2"] },
		],
	};
}

function quizCall(nodeId: string, id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${id}`,
				name: "quiz",
				arguments: { nodeId },
			},
		],
		timestamp: 10,
	} as never;
}

const big = (text: string, kb = 100): LhMessage => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

function depsFor(thresholdTokens: number, summary: string): CompactionDeps {
	return {
		chatStore,
		engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
		modelId: "faux:test",
		kind: "teach",
		thresholdTokens,
		systemPromptTokens: 100,
		summarize: async () => ({
			summary,
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}),
	};
}

describe("compaction and unit cut keep course notes", () => {
	// plan 022 part 1: after a compaction in a chat with binding material and units, the record has the course-files, reference and current-unit method notes right after the compaction marker; courseNotesFor on that record returns nothing
	it("appends course-files, reference, and current-unit course-method notes right after the compaction marker and leaves courseNotesFor empty", async () => {
		const tree = makeTree();
		const material = makeMaterial();
		const chat = chatStore.createChat("compaction with notes");
		chatStore.saveTree(chat.id, tree);
		chatStore.setCourseMaterial(chat.id, material);

		const initialNotes = courseNotesFor([], tree, material);
		chatStore.saveMessages(chat.id, [
			...initialNotes,
			quizCall("n1"),
			big("m1"),
			big("m2"),
			big("m3"),
			newUserMessage("recent"),
		]);

		await ensureCompacted(depsFor(10_000, "Compacted summary."), chat.id);

		const after = chatStore.getChat(chat.id)!.messages;
		const compactionIdx = after.findIndex((m) => m.role === "custom" && m.customType === "compaction");
		assert.ok(compactionIdx >= 0);

		const trailing = after.slice(compactionIdx + 1) as LhMarkerMessage[];
		assert.deepEqual(
			trailing.map((m) => m.customType),
			["course-files", "course-method", "course-method", "reference"],
		);
		assert.deepEqual(
			trailing.filter((m) => m.customType === "course-method").map((m) => (m.details as { nodeId: string }).nodeId),
			["n1", "n2"],
		);
		assert.deepEqual(courseNotesFor(after, tree, material), []);
	});

	// plan 022 part 1: notes are due over the post-compaction messages with the current unit scope (unit 2 taught before the cut)
	it("keeps current-unit scope when compaction runs in unit 2", async () => {
		const tree = makeTree();
		const material = makeMaterial();
		const chat = chatStore.createChat("compaction in unit 2");
		chatStore.saveTree(chat.id, tree);
		chatStore.setCourseMaterial(chat.id, material);

		chatStore.saveMessages(chat.id, [
			...courseNotesFor([], tree, material),
			quizCall("n3"),
			big("m1"),
			big("m2"),
			big("m3"),
			newUserMessage("recent"),
		]);

		await ensureCompacted(depsFor(10_000, "Compacted summary."), chat.id);

		const after = chatStore.getChat(chat.id)!.messages;
		const compactionIdx = after.findIndex((m) => m.role === "custom" && m.customType === "compaction");
		assert.ok(compactionIdx >= 0);
		const trailing = after.slice(compactionIdx + 1) as LhMarkerMessage[];
		assert.deepEqual(
			trailing.filter((m) => m.customType === "course-method").map((m) => (m.details as { nodeId: string }).nodeId),
			["n3"],
		);
		assert.equal(trailing.filter((m) => m.customType === "course-files").length, 1);
		assert.deepEqual(courseNotesFor(after, tree, material), []);
	});

	// plan 022 part 1: a chat without material gets no notes
	it("appends no notes after compaction in a chat without course material", async () => {
		const tree = makeTree();
		const chat = chatStore.createChat("compaction without notes");
		chatStore.saveTree(chat.id, tree);
		chatStore.saveMessages(chat.id, [big("m1"), big("m2"), big("m3"), newUserMessage("recent")]);

		await ensureCompacted(depsFor(10_000, "Compacted summary."), chat.id);

		const after = chatStore.getChat(chat.id)!.messages;
		const compactionIdx = after.findIndex((m) => m.role === "custom" && m.customType === "compaction");
		assert.ok(compactionIdx >= 0);
		assert.equal(compactionIdx, after.length - 1);
	});

	// plan 022 part 1: a unit cut does the same
	it("appends course-files, reference, and current-unit course-method notes right after the lesson-record marker on unit cut and leaves courseNotesFor empty", async () => {
		const tree = makeTree();
		const material = makeMaterial();
		const chat = chatStore.createChat("unit cut with notes");
		chatStore.saveTree(chat.id, tree);
		chatStore.setCourseMaterial(chat.id, material);

		const initialNotes = courseNotesFor([], tree, material);
		chatStore.saveMessages(chat.id, [
			...initialNotes,
			quizCall("n1"),
			newUserMessage("Got n1."),
			quizCall("n3"),
		]);

		const judgment = JSON.stringify({
			learnerWide: "Direct learner.",
			commitments: "",
			nodes: [{ nodeId: "n1", learned: "Understands Node 1.", errorsCorrected: "", openPoints: "" }],
		});
		const outcome = await runUnitCut(depsFor(100_000, judgment), chat.id);
		assert.equal(outcome, "done");

		const after = chatStore.getChat(chat.id)!.messages;
		const recordIdx = after.findIndex((m) => m.role === "custom" && m.customType === "lesson-record");
		assert.ok(recordIdx >= 0);

		const trailing = after.slice(recordIdx + 1) as LhMarkerMessage[];
		assert.deepEqual(
			trailing.map((m) => m.customType),
			["course-files", "course-method", "reference"],
		);
		assert.deepEqual(
			trailing.filter((m) => m.customType === "course-method").map((m) => (m.details as { nodeId: string }).nodeId),
			["n3"],
		);
		assert.deepEqual(courseNotesFor(after, tree, material), []);
	});

	// plan 022 part 1: a unit cut in a chat without material gets no notes
	it("appends no notes after a unit cut in a chat without course material", async () => {
		const tree = makeTree();
		const chat = chatStore.createChat("unit cut without notes");
		chatStore.saveTree(chat.id, tree);
		chatStore.saveMessages(chat.id, [quizCall("n1"), newUserMessage("Got n1."), quizCall("n3")]);

		const judgment = JSON.stringify({
			learnerWide: "Direct learner.",
			commitments: "",
			nodes: [{ nodeId: "n1", learned: "Understands Node 1.", errorsCorrected: "", openPoints: "" }],
		});
		const outcome = await runUnitCut(depsFor(100_000, judgment), chat.id);
		assert.equal(outcome, "done");

		const after = chatStore.getChat(chat.id)!.messages;
		const recordIdx = after.findIndex((m) => m.role === "custom" && m.customType === "lesson-record");
		assert.ok(recordIdx >= 0);
		assert.equal(recordIdx, after.length - 1);
	});

	// plan 022 part 1: course notes ride directly after the lesson-record marker even when a message arrives during the cut
	it("places course notes directly after the lesson-record marker and before messages that arrived during the cut", async () => {
		const tree = makeTree();
		const material = makeMaterial();
		const chat = chatStore.createChat("unit cut with concurrent message");
		chatStore.saveTree(chat.id, tree);
		chatStore.setCourseMaterial(chat.id, material);

		const initialNotes = courseNotesFor([], tree, material);
		chatStore.saveMessages(chat.id, [
			...initialNotes,
			quizCall("n1"),
			newUserMessage("Got n1."),
			quizCall("n3"),
		]);

		const judgment = JSON.stringify({
			learnerWide: "Direct learner.",
			commitments: "",
			nodes: [{ nodeId: "n1", learned: "Understands Node 1.", errorsCorrected: "", openPoints: "" }],
		});
		const late = newUserMessage("arrived during cut");
		const base = depsFor(100_000, judgment);
		const deps: CompactionDeps = {
			...base,
			summarize: async (prompt, engine) => {
				chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, late]);
				return base.summarize!(prompt, engine);
			},
		};
		const outcome = await runUnitCut(deps, chat.id);
		assert.equal(outcome, "done");

		const after = chatStore.getChat(chat.id)!.messages;
		const recordIdx = after.findIndex((m) => m.role === "custom" && m.customType === "lesson-record");
		assert.ok(recordIdx >= 0);

		const afterMarker = after.slice(recordIdx + 1);
		assert.equal(afterMarker.length, 4);
		assert.deepEqual(
			afterMarker.slice(0, 3).map((m) => (m.role === "custom" ? m.customType : m.role)),
			["course-files", "course-method", "reference"],
		);
		assert.equal(afterMarker[3]!.id, late.id);
		assert.deepEqual(courseNotesFor(after, tree, material), []);
	});
});
