import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTeacherTools } from "../src/agent/tools.ts";
import type { ChatRecord, CourseMaterial, PlanTree } from "../src/core/contracts.ts";
import { courseNotesFor } from "../src/core/course-notes.ts";
import { subscribe } from "../src/core/events.ts";
import { newMessageId, type LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

const REPLACE_AT = "2026-11-24T12:00:00.000Z";
const REPLACE_MS = Date.parse(REPLACE_AT);
const BEFORE_MS = Date.parse("2026-11-24T10:00:00.000Z");

function quizCall(nodeId: string, timestamp: number): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${nodeId}_${timestamp}`, name: "quiz", arguments: { nodeId } }],
		timestamp,
	} as never;
}

const tree: PlanTree = {
	nodes: [
		{ id: "n1", title: "Node 1" },
		{ id: "n2", title: "Node 2" },
	],
	edges: [{ from: "n1", to: "n2" }],
	version: 1,
};

function changedMaterial(extra: Partial<CourseMaterial["files"][number]> = {}): CourseMaterial {
	return {
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
					],
					nodes: [
						{ nodeId: "n1", kind: "changed" },
						{ nodeId: "n2", kind: "changed" },
					],
					revisited: [],
					planAsked: true,
				},
				...extra,
			},
		],
		methods: [],
		conflicts: [],
	};
}

function makeHarness(material: CourseMaterial, messages: LhMessage[]) {
	const chatId = "chat_edges";
	let stored = material;
	const record = {
		id: chatId,
		title: "Test",
		createdAt: REPLACE_AT,
		updatedAt: REPLACE_AT,
		messages,
		tree,
	} as ChatRecord;
	const chatStore = {
		getChat: () => ({ ...record, courseMaterial: stored }),
		getCourseMaterial: () => stored,
		setCourseMaterial: (_id: string, m: CourseMaterial) => {
			stored = m;
		},
	} as unknown as ChatStore;
	const tools = createTeacherTools({
		chatId,
		chatStore,
		jobStore: { listJobs: () => [] } as unknown as JobStore,
		spawn: () => {},
		breaks: () => ({ enabled: false, intervalMinutes: 25, lengthMinutes: 5, resetMinutes: 10 }),
		now: () => 0,
	});
	return { tool: tools.course_update!, getMaterial: () => stored };
}

describe("course update edges", () => {
	it("keeps earlier revisited items when another is recorded, and emits once", async () => {
		const h = makeHarness(changedMaterial(), [quizCall("n1", BEFORE_MS), quizCall("n2", BEFORE_MS)]);
		let events = 0;
		const unsubscribe = subscribe((e) => {
			if (e.type === "course-material-changed") events++;
		});
		try {
			await h.tool.execute("a", { path: "/course/v2.pdf", item: "n1" });
			assert.equal(events, 1);
			await h.tool.execute("b", { path: "/course/v2.pdf", item: "n2" });
		} finally {
			unsubscribe();
		}
		assert.deepEqual(h.getMaterial().files[0]?.update?.revisited, ["n1", "n2"]);
	});

	it("a node taught exactly at the replacement time counts as taught after it, not changed", async () => {
		const h = makeHarness(changedMaterial(), [quizCall("n1", REPLACE_MS)]);
		const res = await h.tool.execute("a", { path: "/course/v2.pdf", item: "n1" });
		assert.equal((res.content[0] as { text: string }).text, "Not an open item of this course update: n1");
	});

	it("a replaced file that is no longer binding yields no [Course update] note", () => {
		const material = changedMaterial({ binding: false });
		material.files.push({
			path: "/course/other.pdf",
			addedAt: REPLACE_AT,
			via: "learner",
			binding: true,
			status: "assigned",
		});
		const notes = courseNotesFor([quizCall("n1", BEFORE_MS)], tree, material);
		assert.equal(notes.filter((m) => m.customType === "course-update").length, 0);
	});
});
