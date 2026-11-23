import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-backfill-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { subscribe } = await import("../src/core/events.ts");
const { newAnswerResult, newMessageId, newUserMessage } = await import("../src/core/native-messages.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function assistantToolCall(callId: string, name: string, args: Record<string, unknown>): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: 1,
	} as never;
}

function scriptedEngine(steps: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

async function runTurn(
	chatId: string,
	input: Parameters<typeof handleChatInput>[1],
	engine: PiEngine,
): Promise<void> {
	const ack = await handleChatInput(
		chatId,
		input,
		(opts) => createTeacherAgent(undefined, { engine, messages: opts.messages }),
	);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

describe("course backfill and turn collection", () => {
	// plan 007 part 2: backfill of a record with an answered explain naming two PDFs yields two pending files and emits course-material-changed
	it("backfills a record with an answered explain naming two PDFs into two pending files and emits course-material-changed", async () => {
		const chat = chatStore.createChat("backfill explain");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });
		chatStore.saveMessages(chat.id, [
			newUserMessage("Teach me stability"),
			assistantToolCall("call_explain_1", "explain", { topic: "Stability" }),
			newAnswerResult("call_explain_1", "explain", {
				kind: "explain",
				questionText: "Explain stability",
				dontKnow: false,
				answers: [],
				text: "From `/course/notes.pdf`",
				readingThinking: "Also checked `/course/regelung.pdf`",
				answeredAt: "2026-11-22T00:00:00.000Z",
			}),
		]);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Continue" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Let's continue.")]),
			]));
		} finally {
			off();
		}

		const material = chatStore.getCourseMaterial(chat.id);
		assert.ok(material);
		assert.deepEqual(
			material.files.map((f) => ({ path: f.path, via: f.via, binding: f.binding, status: f.status })),
			[
				{ path: "/course/notes.pdf", via: "learner", binding: true, status: "pending" },
				{ path: "/course/regelung.pdf", via: "learner", binding: true, status: "pending" },
			],
		);
		assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);
	});

	// plan 007 part 2: a second turn with no new paths does not emit the event
	it("does not emit course-material-changed on a second turn with no new paths", async () => {
		const chat = chatStore.createChat("no new paths");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		await runTurn(chat.id, { type: "text", text: "Use `/course/first.pdf`" }, scriptedEngine([
			() => fauxAssistantMessage([fauxText("Got it.")]),
		]));
		assert.equal(chatStore.getCourseMaterial(chat.id)?.files.length, 1);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Tell me more" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Here is more detail.")]),
			]));
		} finally {
			off();
		}

		assert.equal(events.length, 0);
		assert.equal(chatStore.getCourseMaterial(chat.id)?.files.length, 1);
	});

	// plan 007 part 2: a second turn naming an already-collected path changes nothing: no event, no duplicate
	it("does not emit course-material-changed or duplicate a file when a later turn re-mentions a collected path", async () => {
		const chat = chatStore.createChat("re-mention");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		await runTurn(chat.id, { type: "text", text: "Use `/course/first.pdf`" }, scriptedEngine([
			() => fauxAssistantMessage([fauxText("Got it.")]),
		]));

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Again `/course/first.pdf`" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Still that one.")]),
			]));
		} finally {
			off();
		}

		assert.equal(events.length, 0);
		assert.deepEqual(chatStore.getCourseMaterial(chat.id)?.files.map((f) => f.path), ["/course/first.pdf"]);
	});

	// plan 007 part 2: collection never blocks the turn's response; a failure is retried on the next turn
	it("completes the turn when collection fails and collects the file on the next turn", async () => {
		const chat = chatStore.createChat("collection failure");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		const original = chatStore.setCourseMaterial;
		const originalError = console.error;
		const originalWarn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		chatStore.setCourseMaterial = () => {
			throw new Error("disk full");
		};
		try {
			await runTurn(chat.id, { type: "text", text: "Use `/course/a.pdf`" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Got it.")]),
			]));
		} finally {
			chatStore.setCourseMaterial = original;
			console.error = originalError;
			console.warn = originalWarn;
		}
		assert.equal(chatStore.getCourseMaterial(chat.id), null);

		await runTurn(chat.id, { type: "text", text: "Continue" }, scriptedEngine([
			() => fauxAssistantMessage([fauxText("Continuing.")]),
		]));
		assert.deepEqual(
			chatStore.getCourseMaterial(chat.id)?.files.map((f) => ({ path: f.path, status: f.status })),
			[{ path: "/course/a.pdf", status: "pending" }],
		);
	});

	// plan 007 part 2: after a turn's messages are persisted, run courseFilesUsed over the new messages, merge, save, and emit course-material-changed when anything changed
	it("merges newly named or tutor-read files on a later turn and emits course-material-changed", async () => {
		const chat = chatStore.createChat("later turn add");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		await runTurn(chat.id, { type: "text", text: "Start with `/course/one.pdf`" }, scriptedEngine([
			() => fauxAssistantMessage([fauxText("Okay.")]),
		]));

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Also read `/course/two.md`" }, scriptedEngine([
				() => fauxAssistantMessage([
					fauxToolCall("read", { path: "/course/three.tex" }, { id: "call_read_1" }),
					fauxText("Read it."),
				], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Done.")]),
			]));
		} finally {
			off();
		}

		const material = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(
			material?.files.map((f) => ({ path: f.path, via: f.via, status: f.status })),
			[
				{ path: "/course/one.pdf", via: "learner", status: "pending" },
				{ path: "/course/two.md", via: "learner", status: "pending" },
				{ path: "/course/three.tex", via: "tutor", status: "pending" },
			],
		);
		assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);
	});

	// plan 007 part 2: collection runs for teach and practice sessions alike
	it("collects course files for practice sessions as well as teach sessions", async () => {
		const chat = chatStore.createChat("practice course", "practice");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Practice from `/course/sheet.pdf`" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Let's practice.")]),
			]));
		} finally {
			off();
		}

		const material = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(
			material?.files.map((f) => ({ path: f.path, via: f.via, status: f.status })),
			[{ path: "/course/sheet.pdf", via: "learner", status: "pending" }],
		);
		assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);
	});

	// plan 007 part 2: a failure on a later turn after courseMaterial exists is logged and retried on the next turn
	it("retries a failed collection from a later turn when courseMaterial already exists", async () => {
		const chat = chatStore.createChat("later turn failure");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-5.4" } });

		await runTurn(chat.id, { type: "text", text: "Use `/course/a.pdf`" }, scriptedEngine([
			() => fauxAssistantMessage([fauxText("Got a.pdf.")]),
		]));
		assert.deepEqual(chatStore.getCourseMaterial(chat.id)?.files.map((f) => f.path), ["/course/a.pdf"]);

		const original = chatStore.setCourseMaterial;
		const originalError = console.error;
		const originalWarn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		chatStore.setCourseMaterial = () => {
			throw new Error("disk full");
		};
		try {
			await runTurn(chat.id, { type: "text", text: "Also use `/course/b.pdf`" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Got b.pdf.")]),
			]));
		} finally {
			chatStore.setCourseMaterial = original;
			console.error = originalError;
			console.warn = originalWarn;
		}
		assert.deepEqual(chatStore.getCourseMaterial(chat.id)?.files.map((f) => f.path), ["/course/a.pdf"]);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			await runTurn(chat.id, { type: "text", text: "Continue" }, scriptedEngine([
				() => fauxAssistantMessage([fauxText("Continuing.")]),
			]));
		} finally {
			off();
		}

		assert.deepEqual(
			chatStore.getCourseMaterial(chat.id)?.files.map((f) => ({ path: f.path, status: f.status })),
			[
				{ path: "/course/a.pdf", status: "pending" },
				{ path: "/course/b.pdf", status: "pending" },
			],
		);
		assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);
	});
});
