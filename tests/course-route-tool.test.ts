import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import type { ChatRecord, CourseMaterial, PlanTree } from "../src/core/contracts.ts";
import { subscribe } from "../src/core/events.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

function makeTree(): PlanTree {
	return {
		nodes: [
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
		],
		edges: [{ from: "n1", to: "n2" }],
		version: 1,
	};
}

function makeHarness(courseMaterial: CourseMaterial | undefined) {
	const chatId = "chat_test";
	let storedMaterial = courseMaterial;
	let saveCount = 0;
	const record: ChatRecord = {
		id: chatId,
		title: "Test",
		createdAt: "2026-11-22T00:00:00.000Z",
		updatedAt: "2026-11-22T00:00:00.000Z",
		messages: [],
		tree: makeTree(),
		...(storedMaterial ? { courseMaterial: storedMaterial } : {}),
	};

	const chatStore: ChatStore = {
		createChat: () => record,
		getChat: (id) => (id === chatId ? { ...record, ...(storedMaterial ? { courseMaterial: storedMaterial } : {}) } : null),
		listChats: () => [],
		saveMessages: () => {},
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
		tool: tools.course_route!,
		getMaterial: () => storedMaterial,
		getSaveCount: () => saveCount,
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("course_route tool", () => {
	// plan 007 part 4: course_route is registered for the teacher only with the confirmed description
	it("registers course_route for the teacher only with the confirmed description", () => {
		const { chatId, chatStore, tool } = makeHarness(undefined);
		assert.ok(tool);
		assert.equal(
			tool.description,
			"Records which course file's route the learner's course uses for a node whose course files disagree. Call it only after the learner chose via ask_user_question. Later course-method notes show only that route.",
		);

		const proberTools = createProberTools({
			chatId,
			chatStore,
			deliver: () => {},
			jobStore: { listJobs: () => [] } as unknown as JobStore,
			spawn: () => {},
		});
		assert.equal(proberTools.course_route, undefined);
	});

	// plan 007 part 4: course_route sets chosen on the conflict, saves it, emits course-material-changed, and returns exact confirmation
	it("records the chosen route, saves courseMaterial, and emits course-material-changed", async () => {
		const harness = makeHarness({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "S. 2", method: "Method B" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
		});

		const events: Array<{ type: string; chatId?: string }> = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "course-material-changed") {
				events.push(event);
			}
		});
		try {
			const result = await harness.tool.execute("tc1", { nodeId: "n1", path: "/course/b.pdf" });
			assert.equal(resultText(result), "Recorded: node n1 follows b.pdf.");
			assert.equal(harness.getSaveCount(), 1);
			assert.equal(harness.getMaterial()?.conflicts[0]?.chosen, "/course/b.pdf");
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: harness.chatId }]);
		} finally {
			unsubscribe();
		}
	});

	// plan 007 part 4: Unknown node id: <id>
	it("returns exact error for an unknown node id", async () => {
		const harness = makeHarness({
			files: [],
			methods: [],
			conflicts: [],
		});
		const events: string[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "course-material-changed") events.push(event.type);
		});
		try {
			const result = await harness.tool.execute("tc1", { nodeId: "missing-node", path: "/course/a.pdf" });
			assert.equal(resultText(result), "Unknown node id: missing-node");
			assert.equal(harness.getSaveCount(), 0);
			assert.deepEqual(events, []);
		} finally {
			unsubscribe();
		}
	});

	// plan 007 part 4: Node <id> has no conflicting course methods.
	it("returns exact error when the node has no conflicting course methods", async () => {
		const harness = makeHarness({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [{ nodeId: "n2", path: "/course/a.pdf", pages: "S. 1", method: "Method A" }],
			conflicts: [],
		});
		const events: string[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "course-material-changed") events.push(event.type);
		});
		try {
			const result = await harness.tool.execute("tc1", { nodeId: "n2", path: "/course/a.pdf" });
			assert.equal(resultText(result), "Node n2 has no conflicting course methods.");
			assert.equal(harness.getSaveCount(), 0);
			assert.deepEqual(events, []);
		} finally {
			unsubscribe();
		}
	});

	// plan 007 part 4: Not one of this node's conflicting course files: <path>
	it("returns exact error when path is not one of the node's conflicting course files", async () => {
		const harness = makeHarness({
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", pages: "S. 1", method: "Method A" },
				{ nodeId: "n1", path: "/course/b.pdf", pages: "S. 2", method: "Method B" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] }],
		});
		const events: string[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "course-material-changed") events.push(event.type);
		});
		try {
			const result = await harness.tool.execute("tc1", { nodeId: "n1", path: "/course/other.pdf" });
			assert.equal(resultText(result), "Not one of this node's conflicting course files: /course/other.pdf");
			assert.equal(harness.getSaveCount(), 0);
			assert.deepEqual(events, []);
		} finally {
			unsubscribe();
		}
	});
});
