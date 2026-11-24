import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { newMessageId, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

function teachCall(nodeId: string, id = newMessageId()): LhMessage {
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

function makeTree(nodeIds: readonly string[]): PlanTree {
	return {
		nodes: nodeIds.map((id) => ({ id, title: id })),
		edges: [],
		version: 1,
	};
}

describe("POST /api/chats practice course-material inheritance", () => {
	const prevDataDir = process.env.LH_DATA_DIR;
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-practice-route-"));
	let POST: typeof import("../app/api/chats/route.ts").POST;
	let stores: typeof import("../src/server/index.ts").stores;

	before(async () => {
		process.env.LH_DATA_DIR = tmpDir;
		({ POST } = await import("../app/api/chats/route.ts"));
		({ stores } = await import("../src/server/index.ts"));
	});

	after(() => {
		if (prevDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = prevDataDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("inherits course methods from the first provenance point of a picked proposition", async () => {
		const lesson = stores.chatStore.createChat("Signals");
		const tag = teachCall("nyquist-zones");
		const provMsg = newUserMessage("got it");
		stores.chatStore.saveTree(lesson.id, makeTree(["nyquist-zones"]));
		stores.chatStore.saveMessages(lesson.id, [tag, provMsg]);
		stores.chatStore.setCourseMaterial(lesson.id, {
			files: [
				{
					path: "/course/signals.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{
					nodeId: "nyquist-zones",
					path: "/course/signals.pdf",
					pages: "S. 12–15",
					method: "Use folding diagram",
				},
			],
			conflicts: [],
		});

		const node: GraphNode = {
			id: "n_first",
			name: "Nyquist",
			statement: "Nyquist folding",
			aliases: [],
			createdAt: "2026-11-22T00:00:00.000Z",
			provenance: [{ chatId: lesson.id, messageId: provMsg.id }],
		};
		stores.graphStore.appendNode(node);

		const res = await POST(
			new Request("http://localhost/api/chats", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Practice 1",
					kind: "practice",
					graphContext: { propositions: [{ id: node.id, name: node.name, statement: node.statement }] },
				}),
			}),
		);
		const { id } = (await res.json()) as { id: string };
		const created = stores.chatStore.getChat(id);

		assert.deepEqual(created?.courseMaterial, {
			files: [
				{
					path: "/course/signals.pdf",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "inherited",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{
					propositionId: "n_first",
					lessonId: lesson.id,
					nodeId: "nyquist-zones",
					path: "/course/signals.pdf",
					pages: "S. 12–15",
					method: "Use folding diagram",
				},
			],
		});
	});

	it("saves inherited course material when the source lesson has binding files without proposition methods", async () => {
		const lesson = stores.chatStore.createChat("Pending course");
		const tag = teachCall("n1");
		const provMsg = newUserMessage("note");
		stores.chatStore.saveTree(lesson.id, makeTree(["n1"]));
		stores.chatStore.saveMessages(lesson.id, [tag, provMsg]);
		stores.chatStore.setCourseMaterial(lesson.id, {
			files: [
				{
					path: "/course/notes.md",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "tutor",
					binding: true,
					status: "pending",
				},
			],
			methods: [],
			conflicts: [],
		});

		const node: GraphNode = {
			id: "n_files_only",
			name: "OnlyFiles",
			statement: "Only files statement",
			aliases: [],
			createdAt: "2026-11-22T00:00:00.000Z",
			provenance: [{ chatId: lesson.id, messageId: provMsg.id }],
		};
		stores.graphStore.appendNode(node);

		const res = await POST(
			new Request("http://localhost/api/chats", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Practice 2",
					kind: "practice",
					graphContext: { propositions: [{ id: node.id, name: node.name, statement: node.statement }] },
				}),
			}),
		);
		const { id } = (await res.json()) as { id: string };
		const created = stores.chatStore.getChat(id);

		assert.deepEqual(created?.courseMaterial, {
			files: [
				{
					path: "/course/notes.md",
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "inherited",
					binding: true,
					status: "pending",
				},
			],
			methods: [],
			conflicts: [],
			propositionMethods: [],
		});
	});
});
