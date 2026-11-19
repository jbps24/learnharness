/**
 * Side chats through Antigravity: agy cuts any request past 192,000 bytes
 * from the end. A side request that would be cut is refused at admission
 * with a clear error, before anything is sent or saved.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-side-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { newUserMessage } = await import("../src/core/index.ts");
const { ANTIGRAVITY_PROVIDER } = await import("../src/core/contracts/antigravity.ts");
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

function setup(lessonText: string) {
	const faux = createFauxCore({});
	const engine: PiEngine = { model: { ...faux.getModel(), provider: ANTIGRAVITY_PROVIDER, contextWindow: 128_000, maxTokens: 16_384 }, streamFn: faux.streamSimple };
	const contexts: TranscriptContext[] = [];
	faux.appendResponses([(context) => { contexts.push(context); return fauxAssistantMessage("Because."); }]);
	const service = createSideChatService({ chatStore, engineFor: async () => engine, instructions: () => "SIDE-INSTRUCTIONS" });
	const chat = chatStore.createChat("agy side");
	const prose = { ...fauxAssistantMessage(lessonText), id: "prose" } as LhMessage;
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
	const anchor: SideChatAnchor = { messageId: prose.id, partId: `${prose.id}-t0`, blockIndex: 0, blockText: "Lesson" };
	return { service, chatId: chat.id, anchor, contexts };
}

describe("side chat through Antigravity", () => {
	it("refuses a request over the CLI's byte cap before sending or saving anything", async () => {
		// ~100k characters stay far under the token budget but weigh ~200 KB.
		const { service, chatId, anchor, contexts } = setup(`Lesson ${"ä".repeat(100_000)}`);
		const response = await service.ask(chatId, { anchor, text: "why?", quotes: [] });
		assert.equal(response.status, 400);
		const { error } = await response.json() as { error: string };
		assert.match(error, /^This side conversation is too large for the Antigravity CLI \(\d+ KB, limit 187 KB\)\. Start a new side chat or choose another model\.$/);
		assert.equal(contexts.length, 0);
		assert.equal(chatStore.getChat(chatId)!.sideChats, undefined);
	});

	it("answers a request under the cap", async () => {
		const { service, chatId, anchor, contexts } = setup("Lesson about limits.");
		const response = await service.ask(chatId, { anchor, text: "why?", quotes: [] });
		assert.equal(response.status, 200);
		await response.text();
		assert.equal(contexts.length, 1);
	});
});
