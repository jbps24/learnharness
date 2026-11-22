import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { asAgentMessages, newUserMessage, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";

const MIN = 60_000;

let tmpDir: string;
let handleChatInput: typeof import("../src/server/chat-handler.ts").handleChatInput;
let stores: typeof import("../src/server/index.ts").stores;
let runningTurn: typeof import("../src/server/turn-runs.ts").runningTurn;

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-break-notes-"));
	process.env.LH_DATA_DIR = tmpDir;
	process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
	({ handleChatInput } = await import("../src/server/chat-handler.ts"));
	({ stores } = await import("../src/server/index.ts"));
	({ runningTurn } = await import("../src/server/turn-runs.ts"));
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fauxAgentBuilder(): (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage("ok")]);
	return (opts) =>
		new Agent({
			initialState: {
				systemPrompt: "test",
				model: faux.getModel(),
				tools: [],
				messages: opts.messages,
			},
			streamFn: faux.streamSimple,
		}) as unknown as TeachingAgent;
}

function build41MinTranscript(now: number, includeProbeDone: boolean): LhMessage[] {
	const start = now - 41 * MIN;
	const msgs: LhMessage[] = [
		{ ...newUserMessage("start"), id: "u_start", timestamp: start },
	];
	if (includeProbeDone) {
		msgs.push(
			{
				id: "a_probe",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_probe", name: "probe_done", arguments: {} }],
				stopReason: "toolUse",
				timestamp: start + 1000,
			} as never,
			{
				id: "r_probe",
				role: "toolResult",
				toolCallId: "call_probe",
				toolName: "probe_done",
				content: [{ type: "text", text: "ok" }],
				details: { ok: true },
				isError: false,
				timestamp: start + 2000,
			} as never,
		);
	}
	for (const offsetMin of [8, 16, 24, 32, 40]) {
		msgs.push({
			...newUserMessage(`msg_${offsetMin}`),
			id: `u_${offsetMin}`,
			timestamp: start + offsetMin * MIN,
		});
	}
	return msgs;
}

async function runAndSettle(
	chatId: string,
	input: Parameters<typeof handleChatInput>[1],
): Promise<Response> {
	const res = await handleChatInput(chatId, input, fauxAgentBuilder());
	const handle = runningTurn(chatId);
	if (handle) {
		const reader = handle.subscribe().getReader();
		while (!(await reader.read()).done) {}
	}
	return res;
}

describe("break notes in chat-handler", () => {
	// plan 002 part 4: a learner text input at 41 min of learning carries one window note
	it("appends one window break-note on a learner text input at 41 min of learning", async () => {
		const chat = stores.chatStore.createChat("Teach 41m");
		stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		stores.chatStore.saveMessages(chat.id, build41MinTranscript(Date.now(), true));

		const res = await runAndSettle(chat.id, { type: "text", text: "Next topic please" });
		assert.equal(res.status, 200);

		const saved = stores.chatStore.getChat(chat.id)!;
		const breakNotes = saved.messages.filter(
			(m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-note",
		);
		assert.equal(breakNotes.length, 1);
		assert.equal((breakNotes[0]!.details as { kind?: string } | null)?.kind, "window");
	});

	// plan 002 part 4: an automatic steers wake at 41 min carries none
	it("does not append a break-note on an automatic steers wake at 41 min", async () => {
		const chat = stores.chatStore.createChat("Steers 41m");
		stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		stores.chatStore.saveMessages(chat.id, build41MinTranscript(Date.now(), true));

		const steer = buildSubagentSteer(
			{ id: "job_break_test", kind: "research", toolCallId: "call_res_1" },
			{ brief: "Brief", sources: [] },
		);
		const res = await runAndSettle(chat.id, { type: "steers", steers: asAgentMessages([steer]) as unknown as LhMessage[] });
		assert.equal(res.status, 200);

		const saved = stores.chatStore.getChat(chat.id)!;
		const breakNotes = saved.messages.filter(
			(m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-note",
		);
		assert.equal(breakNotes.length, 0);
	});

	// plan 002 part 4: a practice chat never carries break notes
	it("never appends break notes on a practice chat", async () => {
		const chat = stores.chatStore.createChat("Practice 41m", "practice");
		stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		stores.chatStore.saveMessages(chat.id, build41MinTranscript(Date.now(), false));

		const res = await runAndSettle(chat.id, { type: "text", text: "Let's practice" });
		assert.equal(res.status, 200);

		const saved = stores.chatStore.getChat(chat.id)!;
		const breakNotes = saved.messages.filter(
			(m): m is LhMarkerMessage => m.role === "custom" && m.customType === "break-note",
		);
		assert.equal(breakNotes.length, 0);
	});
});
