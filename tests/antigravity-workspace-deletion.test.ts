import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { readLink, removeWorkspace, workspaceFor, writeLink } from "../src/agent/antigravity/link.ts";
import { createChat, deleteChatSession } from "../src/server/chats.ts";
import { subscribe } from "../src/core/events.ts";
import { deleteIdleChatRecord } from "../src/server/chats.ts";

const cleanupChatIds: string[] = [];

afterEach(async () => {
	while (cleanupChatIds.length > 0) {
		const id = cleanupChatIds.pop()!;
		try {
			await deleteChatSession(id, "preserve-graph");
		} catch {
			// Best-effort cleanup.
		}
		try {
			removeWorkspace(id);
		} catch {
			// Best-effort cleanup.
		}
	}
});

describe("antigravity workspace deletion", () => {
	// plan 019 part 1: deleting a chat removes its workspace
	it("removes the chat's antigravity workspace when the chat is deleted", async () => {
		const chat = createChat("Agy workspace delete");
		cleanupChatIds.push(chat.id);
		const ws = workspaceFor(chat.id);
		writeLink(chat.id, { conversationId: "conv-del-1", fingerprint: "fp-del-1" });
		assert.equal(fs.existsSync(ws), true);

		const outcome = await deleteChatSession(chat.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(ws), false);
	});

	// plan 019 part 1: deleting another chat leaves it alone
	it("leaves another chat's workspace and link intact when deleting a different chat", async () => {
		const chatA = createChat("Agy workspace A");
		const chatB = createChat("Agy workspace B");
		cleanupChatIds.push(chatA.id, chatB.id);

		const wsA = workspaceFor(chatA.id);
		const wsB = workspaceFor(chatB.id);
		const linkB = { conversationId: "conv-b", fingerprint: "fp-b" };
		writeLink(chatA.id, { conversationId: "conv-a", fingerprint: "fp-a" });
		writeLink(chatB.id, linkB);

		const outcome = await deleteChatSession(chatA.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(wsA), false);
		assert.equal(fs.existsSync(wsB), true);
		assert.deepEqual(readLink(chatB.id), linkB);
	});
});

describe("antigravity workspace deletion edge cases", () => {
	it("removes the workspace and link after deleting the chat record in deleteChatSession", async () => {
		const chat = createChat("Agy workspace order");
		cleanupChatIds.push(chat.id);
		const ws = workspaceFor(chat.id);
		writeLink(chat.id, { conversationId: "conv-order", fingerprint: "fp-order" });

		let workspaceExistedOnChatsChanged: boolean | undefined;
		const unsubscribe = subscribe((event) => {
			if (event.type === "chats-changed") {
				workspaceExistedOnChatsChanged = fs.existsSync(ws);
			}
		});
		try {
			const outcome = await deleteChatSession(chat.id, "preserve-graph");
			assert.equal(outcome.ok, true);
		} finally {
			unsubscribe();
		}

		assert.equal(workspaceExistedOnChatsChanged, true);
		assert.equal(fs.existsSync(ws), false);
		assert.equal(readLink(chat.id), null);
	});

	it("removes the workspace and link when deleting an idle chat record directly", () => {
		const chatA = createChat("Agy idle delete A");
		const chatB = createChat("Agy idle delete B");
		cleanupChatIds.push(chatA.id, chatB.id);

		const wsA = workspaceFor(chatA.id);
		const wsB = workspaceFor(chatB.id);
		const linkB = { conversationId: "conv-idle-b", fingerprint: "fp-idle-b" };
		writeLink(chatA.id, { conversationId: "conv-idle-a", fingerprint: "fp-idle-a" });
		writeLink(chatB.id, linkB);

		const outcome = deleteIdleChatRecord(chatA.id);
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(wsA), false);
		assert.equal(readLink(chatA.id), null);
		assert.equal(fs.existsSync(wsB), true);
		assert.deepEqual(readLink(chatB.id), linkB);
	});
});
