import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("chatStore courseMaterial", () => {
	// plan 007 part 2: getCourseMaterial(chatId) returns null when chat is unknown or has no courseMaterial
	it("returns null for an unknown chat id and for a chat with no courseMaterial set", () => {
		assert.equal(chatStore.getCourseMaterial("chat_missing"), null);
		const chat = chatStore.createChat("no material yet");
		assert.equal(chatStore.getCourseMaterial(chat.id), null);
	});

	// plan 007 part 2: setCourseMaterial(chatId, material) writes courseMaterial atomically like other record fields and getCourseMaterial(chatId) reads it back
	it("persists and reads back courseMaterial atomically while preserving other record fields", () => {
		const chat = chatStore.createChat("linear algebra");
		chatStore.saveMessages(chat.id, [newUserMessage("Hello")]);
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "svd", title: "SVD" }],
			edges: [],
			version: 1,
		});

		const material: CourseMaterial = {
			files: [
				{
					path: "/course/linalg.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
				},
			],
			methods: [
				{
					nodeId: "svd",
					path: "/course/linalg.pdf",
					pages: "S. 10-14",
					method: "Compute A^T A eigenvalues first.",
				},
			],
			conflicts: [],
		};

		chatStore.setCourseMaterial(chat.id, material);
		assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);

		const reloaded = chatStore.getChat(chat.id);
		assert.ok(reloaded);
		assert.equal(reloaded.title, "linear algebra");
		assert.equal(reloaded.messages.length, 1);
		assert.equal(reloaded.tree?.nodes[0]?.id, "svd");
		assert.deepEqual(reloaded.courseMaterial, material);
	});

	// plan 007 part 2: a write for an unknown chat must not be lost silently
	it("throws when setCourseMaterial is called for an unknown chat", () => {
		assert.throws(() => chatStore.setCourseMaterial("chat_missing", { files: [], methods: [], conflicts: [] }), /Chat not found: chat_missing/);
	});

	// course bookkeeping is not conversation activity: updatedAt stays put
	it("leaves updatedAt unchanged when setCourseMaterial writes", async () => {
		const chat = chatStore.createChat("stable order");
		const before = chatStore.getChat(chat.id)!.updatedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		chatStore.setCourseMaterial(chat.id, { files: [], methods: [], conflicts: [] });
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before);
	});
});
