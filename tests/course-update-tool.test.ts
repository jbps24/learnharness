import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import type { ChatRecord, CourseMaterial, PlanTree } from "../src/core/contracts.ts";
import { newMessageId, type LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

const BEFORE_REPLACE_MS = Date.parse("2026-11-24T10:00:00.000Z");
const REPLACE_AT = "2026-11-24T12:00:00.000Z";
const AFTER_REPLACE_MS = Date.parse("2026-11-24T14:00:00.000Z");

function quizCall(nodeId: string, timestamp = BEFORE_REPLACE_MS): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${nodeId}_${timestamp}`,
				name: "quiz",
				arguments: { nodeId },
			},
		],
		timestamp,
	} as never;
}

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
		version: 1,
	};
}

function makeHarness(courseMaterial: CourseMaterial | undefined, messages: LhMessage[] = []) {
	const chatId = "chat_test";
	let storedMaterial = courseMaterial;
	let saveCount = 0;
	const record: ChatRecord = {
		id: chatId,
		title: "Test",
		createdAt: "2026-11-24T00:00:00.000Z",
		updatedAt: "2026-11-24T00:00:00.000Z",
		messages,
		tree: makeTree(),
		...(storedMaterial ? { courseMaterial: storedMaterial } : {}),
	};

	const chatStore: ChatStore = {
		createChat: () => record,
		getChat: (id) => (id === chatId ? { ...record, ...(storedMaterial ? { courseMaterial: storedMaterial } : {}) } : null),
		listChats: () => [],
		saveMessages: () => {},
		retireReply: () => { throw new Error("retireReply is not used here"); },
		saveImageSnapshot: () => {},
		saveTree: () => {},
		appendTurnUsage: () => {},
		appendExtractionUsage: () => {},
		saveSettings: () => {},
		renameChat: () => record,
		deleteChat: () => false,
		updateSideChats: () => null,
		getCourseMaterial: (id) => (id === chatId ? (storedMaterial ?? null) : null),
		setCourseMaterial: (id, material) => {
			if (id !== chatId) return;
			storedMaterial = material;
			saveCount++;
		},
	};

	const tools = createTeacherTools({
		chatId,
		chatStore,
		jobStore: { listJobs: () => [] } as unknown as JobStore,
		spawn: () => {},
		breaks: () => ({ enabled: false, intervalMinutes: 25, lengthMinutes: 5, resetMinutes: 10 }),
		now: () => 0,
	});

	return {
		chatId,
		chatStore,
		tool: tools.course_update!,
		getMaterial: () => storedMaterial,
		getSaveCount: () => saveCount,
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("course_update tool", () => {
	// plan 015 part 3: course_update tool is teacher-only with confirmed description
	it("registers course_update for the teacher only with the confirmed description", () => {
		const { chatId, chatStore, tool } = makeHarness(undefined);
		assert.ok(tool);
		assert.equal(
			tool.description,
			'Records that you handled one item of a [Course update] note: a changed route you pointed out (the node id) or the plan question you asked ("plan"). Handled items leave the note.',
		);

		const proberTools = createProberTools({
			chatId,
			chatStore,
			deliver: () => {},
			jobStore: { listJobs: () => [] } as unknown as JobStore,
			spawn: () => {},
		});
		assert.equal(proberTools.course_update, undefined);
	});

	// plan 015 part 3: course_update adds changed-and-taught node id to revisited and returns Recorded.
	it("adds a changed-and-taught node id to revisited, saves, emits course-material-changed, and returns Recorded.", async () => {
		const harness = makeHarness(
			{
				files: [
					{
						path: "/course/v2.pdf",
						addedAt: REPLACE_AT,
						via: "learner",
						binding: true,
						status: "assigned",
						update: {
							at: REPLACE_AT,
							fromPath: "/course/v1.pdf",
							previous: [{ nodeId: "n1", pages: "S. 1", method: "Old" }],
							nodes: [{ nodeId: "n1", kind: "changed" }],
							revisited: [],
							planAsked: true,
						},
					},
				],
				methods: [{ nodeId: "n1", path: "/course/v2.pdf", pages: "S. 2", method: "New" }],
				conflicts: [],
			},
			[quizCall("n1", BEFORE_REPLACE_MS)],
		);

		const result = await harness.tool.execute("tc1", { path: "/course/v2.pdf", item: "n1" });
		assert.equal(resultText(result), "Recorded.");
		assert.equal(harness.getSaveCount(), 1);
		assert.deepEqual(harness.getMaterial()?.files[0]?.update?.revisited, ["n1"]);
	});

	// plan 015 part 3: course_update with "plan" sets planAsked and returns Recorded.
	it('sets planAsked to true when item is "plan", saves, emits, and returns Recorded.', async () => {
		const harness = makeHarness({
			files: [
				{
					path: "/course/v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/v1.pdf",
						previous: [],
						nodes: [{ nodeId: "n3", kind: "dropped" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		});

		const result = await harness.tool.execute("tc1", { path: "/course/v2.pdf", item: "plan" });
		assert.equal(resultText(result), "Recorded.");
		assert.equal(harness.getSaveCount(), 1);
		assert.equal(harness.getMaterial()?.files[0]?.update?.planAsked, true);
	});

	// plan 015 part 3: error "No course update for <path>."
	it("returns exact error when the file is missing or has no course update", async () => {
		const harness = makeHarness({
			files: [
				{
					path: "/course/plain.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		const missingFile = await harness.tool.execute("tc1", { path: "/course/missing.pdf", item: "plan" });
		assert.equal(resultText(missingFile), "No course update for /course/missing.pdf.");

		const noUpdate = await harness.tool.execute("tc2", { path: "/course/plain.pdf", item: "plan" });
		assert.equal(resultText(noUpdate), "No course update for /course/plain.pdf.");

		assert.equal(harness.getSaveCount(), 0);
	});

	// plan 015 part 3: error "Not an open item of this course update: <item>"
	it("returns exact error for untaught, post-replacement, revisited, unknown, or already-handled plan items", async () => {
		const harness = makeHarness(
			{
				files: [
					{
						path: "/course/v2.pdf",
						addedAt: REPLACE_AT,
						via: "learner",
						binding: true,
						status: "assigned",
						update: {
							at: REPLACE_AT,
							fromPath: "/course/v1.pdf",
							previous: [
								{ nodeId: "n1", pages: "S. 1", method: "Old 1" },
								{ nodeId: "n2", pages: "S. 2", method: "Old 2" },
								{ nodeId: "n3", pages: "S. 3", method: "Old 3" },
							],
							nodes: [
								{ nodeId: "n1", kind: "changed" },
								{ nodeId: "n2", kind: "changed" },
								{ nodeId: "n3", kind: "changed" },
								{ nodeId: "n4", kind: "same" },
								{ nodeId: "n5", kind: "dropped" },
							],
							revisited: ["n1"],
							planAsked: true,
						},
					},
				],
				methods: [],
				conflicts: [],
			},
			[
				quizCall("n1", BEFORE_REPLACE_MS),
				quizCall("n3", AFTER_REPLACE_MS),
				quizCall("n4", BEFORE_REPLACE_MS),
				quizCall("n5", BEFORE_REPLACE_MS),
			],
		);

		for (const item of ["n1", "n2", "n3", "n4", "n5", "unknown", "plan"]) {
			const res = await harness.tool.execute("tc", { path: "/course/v2.pdf", item });
			assert.equal(resultText(res), `Not an open item of this course update: ${item}`, item);
		}
		assert.equal(harness.getSaveCount(), 0);
	});

	// plan 015 part 3: "plan" is open only with dropped nodes or new sections and planAsked false
	it('rejects "plan" when planAsked is false but there are no dropped nodes and no new sections', async () => {
		const harness = makeHarness({
			files: [
				{
					path: "/course/v2.pdf",
					addedAt: REPLACE_AT,
					via: "learner",
					binding: true,
					status: "assigned",
					update: {
						at: REPLACE_AT,
						fromPath: "/course/v1.pdf",
						previous: [],
						nodes: [{ nodeId: "n1", kind: "same" }],
						newSections: [],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		});
		const res = await harness.tool.execute("tc", { path: "/course/v2.pdf", item: "plan" });
		assert.equal(resultText(res), "Not an open item of this course update: plan");
		assert.equal(harness.getSaveCount(), 0);
	});
});
