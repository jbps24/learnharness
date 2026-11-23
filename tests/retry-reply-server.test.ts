/**
 * Server and store tests for plan 006 part 2 (`retireReply` and `retry-reply`).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retry-reply-server-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function assistantText(id: string, text: string): LhMessage {
	const base = fauxAssistantMessage([fauxText(text)], { stopReason: "stop" });
	return { ...base, id } as LhMessage;
}

function assistantToolCall(id: string, callId: string, toolName: string, args: JsonObject): LhMessage {
	const base = fauxAssistantMessage([fauxToolCall(toolName, args, { id: callId })], { stopReason: "toolUse" });
	return { ...base, id } as LhMessage;
}

function toolResult(id: string, callId: string, toolName: string, text: string): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		details: text,
		isError: false,
		timestamp: Date.now(),
	} as LhMessage;
}

function createConfiguredChat(title: string, kind?: "practice") {
	const chat = chatStore.createChat(title, kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

function scriptedTeacher(steps: (calls: Array<{ role: string; content: unknown }[]>) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: Array<{ role: string; content: unknown }[]>;
} {
	const calls: Array<{ role: string; content: unknown }[]> = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return;
	await new Response(handle.subscribe()).text();
}

describe("retireReply store method", () => {
	// plan 006 part 2: retireReply on a temp store: messages [u, a1, r1, a2], ids [a1, r1, a2] -> messages is [u], retiredReplies is [{ at, messages: [a1, r1, a2] }]
	it("removes messages by id in record order and appends { at, messages } to retiredReplies", () => {
		const chat = createConfiguredChat("Retire store test");
		const u = newUserMessage("Explain derivatives");
		const a1 = assistantToolCall("a1", "c1", "read", { path: "notes.md" });
		const r1 = toolResult("r1", "c1", "read", "notes content");
		const a2 = assistantText("a2", "Here is an explanation.");
		chatStore.saveMessages(chat.id, [u, a1, r1, a2]);

		const at = "2026-11-22T10:00:00.000Z";
		// ids deliberately out of record order: the stored entry keeps record order
		chatStore.retireReply(chat.id, [a2.id, a1.id, r1.id], at);

		const updated = chatStore.getChat(chat.id)!;
		assert.deepEqual(updated.messages.map((m) => m.id), [u.id]);
		assert.equal(updated.retiredReplies?.length, 1);
		assert.equal(updated.retiredReplies![0]!.at, at);
		assert.deepEqual(
			updated.retiredReplies![0]!.messages.map((m) => m.id),
			[a1.id, r1.id, a2.id],
		);
	});

	// plan 006 part 2: a second call appends a second entry to retiredReplies
	it("appends a second entry on a second retireReply call", () => {
		const chat = createConfiguredChat("Retire store second call");
		const u1 = newUserMessage("First question");
		const a1 = assistantText("a1", "First reply");
		const u2 = newUserMessage("Second question");
		const a2 = assistantText("a2", "Second reply");
		chatStore.saveMessages(chat.id, [u1, a1, u2, a2]);

		const at1 = "2026-11-22T10:00:00.000Z";
		const at2 = "2026-11-22T10:05:00.000Z";
		chatStore.retireReply(chat.id, [a2.id], at1);
		chatStore.retireReply(chat.id, [a1.id], at2);

		const updated = chatStore.getChat(chat.id)!;
		assert.deepEqual(updated.messages.map((m) => m.id), [u1.id, u2.id]);
		assert.equal(updated.retiredReplies?.length, 2);
		assert.equal(updated.retiredReplies![0]!.at, at1);
		assert.deepEqual(updated.retiredReplies![0]!.messages.map((m) => m.id), [a2.id]);
		assert.equal(updated.retiredReplies![1]!.at, at2);
		assert.deepEqual(updated.retiredReplies![1]!.messages.map((m) => m.id), [a1.id]);
	});

	// plan 006 part 2: an unknown id throws and changes nothing; throws if the chat is missing
	it("throws on an unknown message id and leaves the record unchanged, and throws on a missing chat", () => {
		const chat = createConfiguredChat("Retire store unknown id");
		const u = newUserMessage("Hello");
		const a = assistantText("a1", "Hi");
		chatStore.saveMessages(chat.id, [u, a]);
		const before = chatStore.getChat(chat.id)!;

		assert.throws(() => {
			chatStore.retireReply(chat.id, ["missing-id"], "2026-11-22T10:00:00.000Z");
		});
		const afterUnknown = chatStore.getChat(chat.id)!;
		assert.deepEqual(afterUnknown.messages, before.messages);
		assert.equal(afterUnknown.retiredReplies, undefined);

		// a mix of a valid and an unknown id also throws and changes nothing
		assert.throws(() => {
			chatStore.retireReply(chat.id, [a.id, "missing-id"], "2026-11-22T10:00:00.000Z");
		});
		const afterMixed = chatStore.getChat(chat.id)!;
		assert.deepEqual(afterMixed.messages, before.messages);
		assert.equal(afterMixed.retiredReplies, undefined);

		assert.throws(() => {
			chatStore.retireReply("missing-chat-id", ["a1"], "2026-11-22T10:00:00.000Z");
		});
	});
});

describe("chat-handler retry-reply", () => {
	// plan 006 part 2: teaching chat ending in user + assistant text, POST { type: retry-reply } -> saved [user, new assistant Second], retiredReplies[0].messages holds old assistant, request ends with user message
	it("retires the old assistant reply, reruns on the fake model, saves [user, Second], and sends no old reply to the model", async () => {
		const chat = createConfiguredChat("Retry reply happy path");
		const u = newUserMessage("Explain the chain rule");
		const oldReply = assistantText("old-a1", "First");
		chatStore.saveMessages(chat.id, [u, oldReply]);

		const { engine, calls } = scriptedTeacher((captured) => [
			(context) => {
				captured.push(context.messages.map((m) => ({ role: m.role, content: (m as { content: unknown }).content })));
				return fauxAssistantMessage([fauxText("Second")]);
			},
		]);

		await drainTurn(post(chat.id, { type: "retry-reply" }), agentFactory(engine));

		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, 2);
		assert.equal(saved.messages[0]!.id, u.id);
		assert.equal(saved.messages[1]!.role, "assistant");
		const newTextBlock = saved.messages[1]!.role === "assistant"
			? saved.messages[1]!.content.find((b) => b.type === "text")
			: undefined;
		assert.equal(newTextBlock?.type === "text" ? newTextBlock.text : undefined, "Second");

		assert.equal(saved.retiredReplies?.length, 1);
		assert.deepEqual(
			saved.retiredReplies![0]!.messages.map((m) => m.id),
			[oldReply.id],
		);

		assert.equal(calls.length, 1);
		const sent = calls[0]!;
		assert.equal(sent[sent.length - 1]!.role, "user");
		assert.ok(!JSON.stringify(sent).includes("First"), "old reply must not be sent to the model");
	});

	// plan 006 part 2: handler refusal 400 "There is no reply to retry." with record unchanged for practice chat
	it("refuses a practice chat with 400 and leaves the record unchanged", async () => {
		const chat = createConfiguredChat("Retry reply practice refusal", "practice");
		const u = newUserMessage("Try a problem");
		const a = assistantText("a1", "Here is a problem.");
		chatStore.saveMessages(chat.id, [u, a]);
		const before = chatStore.getChat(chat.id)!;

		const { engine } = scriptedTeacher(() => []);
		const res = await handleChatRequest(post(chat.id, { type: "retry-reply" }), agentFactory(engine));

		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "There is no reply to retry." });
		const afterRecord = chatStore.getChat(chat.id)!;
		assert.deepEqual(afterRecord.messages, before.messages);
		assert.equal(afterRecord.retiredReplies, undefined);
	});

	// plan 006 part 2: handler refusal 400 "There is no reply to retry." with record unchanged for record ending in a user message
	it("refuses a record ending in a user message with 400 and leaves the record unchanged", async () => {
		const chat = createConfiguredChat("Retry reply user-tail refusal");
		const u = newUserMessage("Unanswered question");
		chatStore.saveMessages(chat.id, [u]);
		const before = chatStore.getChat(chat.id)!;

		const { engine } = scriptedTeacher(() => []);
		const res = await handleChatRequest(post(chat.id, { type: "retry-reply" }), agentFactory(engine));

		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "There is no reply to retry." });
		const afterRecord = chatStore.getChat(chat.id)!;
		assert.deepEqual(afterRecord.messages, before.messages);
		assert.equal(afterRecord.retiredReplies, undefined);
	});

	// plan 006 part 2: handler refusal 400 "There is no reply to retry." with record unchanged for reply that called demo
	it("refuses a reply that called demo with 400 and leaves the record unchanged", async () => {
		const chat = createConfiguredChat("Retry reply demo refusal");
		const u = newUserMessage("Show me a demo");
		const a1 = assistantToolCall("a1", "call-demo", "demo", { title: "Demo" });
		const r1 = toolResult("r1", "call-demo", "demo", "Dispatched.");
		const a2 = assistantText("a2", "Started a demo.");
		chatStore.saveMessages(chat.id, [u, a1, r1, a2]);
		const before = chatStore.getChat(chat.id)!;

		const { engine } = scriptedTeacher(() => []);
		const res = await handleChatRequest(post(chat.id, { type: "retry-reply" }), agentFactory(engine));

		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "There is no reply to retry." });
		const afterRecord = chatStore.getChat(chat.id)!;
		assert.deepEqual(afterRecord.messages, before.messages);
		assert.equal(afterRecord.retiredReplies, undefined);
	});
});
