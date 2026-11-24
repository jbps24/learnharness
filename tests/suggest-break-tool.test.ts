import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONVERSATION_TOOL_NAMES } from "../src/agent/teacher-agent.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { suggestBreakTool } from "../src/agent/tools/breaks.ts";
import type { ChatRecord } from "../src/core/contracts.ts";
import {
	newAnswerResult,
	newBreakEndedMessage,
	newBreakNoteMessage,
	newBreakSkippedMessage,
	newBreakTakenMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

const T0 = 1_700_000_000_000;
const DEFAULT_BREAKS = { enabled: true, intervalMinutes: 45, lengthMinutes: 5, resetMinutes: 5 };

const EXPECTED_DESCRIPTION =
	'Offer the learner a short break. Call it when a [Session note] says a break is due, in that same turn, or whenever the learner asks for one (requestedBy "learner"). First say it in one line of ordinary prose, then call this tool and end your turn. With oneMoreQuestion true, your line offers the one question that would close the current node first. The learner chooses in the app; don\'t ask them again in prose.';
const R5 = 'oneMoreQuestion only goes with requestedBy "window".';
const OK1 = "Break offered. End your turn now; the learner chooses in the app.";
const R1 = 'No break is due right now. Suggest a break only after a [Session note] says one is due, or when the learner asks (requestedBy "learner").';
const R2 = "Teaching hasn't started yet. A due break waits for the first closed point in teaching.";
const R3 = "A question is still open. Suggest the break after it is answered and the step is closed.";
const R4 = "A break offer is already open.";

const SYNTHETIC_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeChatStore(messages: LhMessage[]): ChatStore {
	const record: ChatRecord = {
		id: "chat_1",
		title: "Test",
		createdAt: "2026-11-21T00:00:00.000Z",
		updatedAt: "2026-11-21T00:00:00.000Z",
		messages,
	};
	return {
		getChat: (id: string) => (id === record.id ? record : null),
	} as unknown as ChatStore;
}

function userMsg(id: string, timestamp: number): LhMessage {
	return { id, role: "user", content: "hi", timestamp };
}

function assistantCall(
	id: string,
	callId: string,
	name: string,
	args: Record<string, unknown>,
	timestamp: number,
): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args as never }],
		api: "faux",
		provider: "synthetic",
		model: "synthetic",
		usage: SYNTHETIC_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultMsg(
	id: string,
	toolCallId: string,
	toolName: string,
	details: unknown,
	timestamp: number,
): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details: details as never,
		isError: false,
		timestamp,
	};
}

function teachQuizCall(id: string, callId: string, timestamp: number): LhMessage {
	return assistantCall(
		id,
		callId,
		"quiz",
		{
			question: "What is 2+2?",
			options: [{ label: "3" }, { label: "4" }],
			correctAnswer: "4",
			nodeId: "basics",
		},
		timestamp,
	);
}

function answeredQuiz(callId: string, timestamp: number): LhMessage[] {
	return [
		teachQuizCall(`m_${callId}`, callId, timestamp),
		{
			...newAnswerResult(callId, "quiz", {
				kind: "quiz",
				questionText: "What is 2+2?",
				dontKnow: false,
				answers: ["4"],
				answeredAt: "2026-11-21T00:00:00.000Z",
			}),
			timestamp: timestamp + 1,
		},
	];
}

function windowNote(timestamp: number): LhMessage {
	return newBreakNoteMessage("window", "[Session note] break due", undefined, timestamp);
}

async function execSuggestBreak(
	messages: LhMessage[],
	requestedBy: "window" | "learner",
	now = T0 + 60_000,
	oneMoreQuestion?: boolean,
) {
	const tool = suggestBreakTool({
		chatId: "chat_1",
		chatStore: fakeChatStore(messages),
		breaks: () => DEFAULT_BREAKS,
		now: () => now,
	}).suggest_break!;
	const res = await tool.execute(
		"call_sb_exec",
		oneMoreQuestion !== undefined ? { requestedBy, oneMoreQuestion } : { requestedBy },
	);
	const text = res.content[0]?.type === "text" ? res.content[0].text : "";
	return { text, details: res.details };
}

describe("suggest_break tool", () => {
	// plan 002 part 3: createTeacherTools contains suggest_break; the prober registry does not; CONVERSATION_TOOL_NAMES includes suggest_break
	it("is registered in createTeacherTools and CONVERSATION_TOOL_NAMES, not in createProberTools", () => {
		const chatStore = fakeChatStore([]);
		const jobStore = {} as unknown as JobStore;
		const spawn = () => {};
		const teacherTools = createTeacherTools({
			chatId: "chat_1",
			chatStore,
			jobStore,
			spawn,
			breaks: () => DEFAULT_BREAKS,
			now: () => T0,
		});
		const proberTools = createProberTools({
			chatId: "chat_1",
			chatStore,
			jobStore,
			spawn,
			deliver: () => {},
		});
		assert.ok("suggest_break" in teacherTools);
		assert.ok(!("suggest_break" in proberTools));
		assert.ok(CONVERSATION_TOOL_NAMES.includes("suggest_break"));
	});

	// plan 002 part 3: exact confirmed tool description
	it("carries the confirmed tool description", () => {
		const tool = suggestBreakTool({
			chatId: "chat_1",
			chatStore: fakeChatStore([]),
			breaks: () => DEFAULT_BREAKS,
			now: () => T0,
		}).suggest_break!;
		assert.equal(tool.description, EXPECTED_DESCRIPTION);
	});

	// plan 002 part 3: check 1 (no open window -> R1)
	it("refuses requestedBy window with R1 when no window is open", async () => {
		const messages: LhMessage[] = [userMsg("u1", T0), ...answeredQuiz("q1", T0 + 1000)];
		const res = await execSuggestBreak(messages, "window");
		assert.equal(res.text, R1);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: check 2 (no teach-tagged call yet -> R2)
	it("refuses requestedBy window with R2 when teaching has not started", async () => {
		const messages: LhMessage[] = [userMsg("u1", T0), windowNote(T0 + 1000)];
		const res = await execSuggestBreak(messages, "window");
		assert.equal(res.text, R2);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: check 3 (hasUnresolvedQuestion -> R3)
	it("refuses requestedBy window with R3 when a question is still open", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			windowNote(T0 + 1000),
			teachQuizCall("a1", "q1", T0 + 2000),
		];
		const res = await execSuggestBreak(messages, "window");
		assert.equal(res.text, R3);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: checks run in order 1, 2, 3, 4 for requestedBy window
	it("checks window guards in order 1 -> 2 -> 3 -> 4", async () => {
		// 1 before 2 & 3: no window, no teach tag, open probe question -> R1
		const noWindow = await execSuggestBreak(
			[
				userMsg("u1", T0),
				assistantCall(
					"a1",
					"p1",
					"probe",
					{ question: "Ready?", options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes" },
					T0 + 1000,
				),
			],
			"window",
		);
		assert.equal(noWindow.text, R1);

		// 2 before 3: open window, no teach tag, open probe question -> R2
		const noTeach = await execSuggestBreak(
			[
				userMsg("u1", T0),
				windowNote(T0 + 1000),
				assistantCall(
					"a1",
					"p1",
					"probe",
					{ question: "Ready?", options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes" },
					T0 + 2000,
				),
			],
			"window",
		);
		assert.equal(noTeach.text, R2);

		// 3 before 4: open window, teach tag, open question, taken break -> R3
		const openQuestionWithTaken = await execSuggestBreak(
			[
				userMsg("u1", T0),
				assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
				toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
				newBreakTakenMessage("sb1", 5, T0 + 700),
				windowNote(T0 + 1000),
				teachQuizCall("a1", "q1", T0 + 2000),
			],
			"window",
		);
		assert.equal(openQuestionWithTaken.text, R3);
	});

	// plan 002 part 3: check 4 (latest.outcome pending -> R4)
	it("refuses requestedBy learner with R4 when a break offer is pending", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
			toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
		];
		const res = await execSuggestBreak(messages, "learner");
		assert.equal(res.text, R4);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: check 4 (latest.outcome taken -> R4)
	it("refuses requestedBy learner with R4 when a break is currently taken", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
			toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
			newBreakTakenMessage("sb1", 5, T0 + 700),
		];
		const res = await execSuggestBreak(messages, "learner");
		assert.equal(res.text, R4);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: check 4 applies to both requestedBy values
	it("refuses requestedBy window with R4 when latest.outcome is taken", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
			toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
			newBreakTakenMessage("sb1", 5, T0 + 700),
			windowNote(T0 + 1000),
			...answeredQuiz("q1", T0 + 2000),
		];
		const res = await execSuggestBreak(messages, "window");
		assert.equal(res.text, R4);
		assert.deepEqual(res.details, { ok: false });
	});

	// plan 002 part 3: a learner request passes with an open question and no window, returning OK1 and ok true
	it("allows requestedBy learner with an open question and no window", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			teachQuizCall("a1", "q1", T0 + 1000),
		];
		const res = await execSuggestBreak(messages, "learner");
		assert.equal(res.text, OK1);
		assert.deepEqual(res.details, { ok: true, requestedBy: "learner" });
	});

	// plan 002 part 3: learner request is only refused when latest.outcome is pending or taken
	it("allows requestedBy learner after a skipped or ended break", async () => {
		const skipped: LhMessage[] = [
			userMsg("u1", T0),
			assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
			toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
			newBreakSkippedMessage("sb1", T0 + 700),
		];
		const resSkipped = await execSuggestBreak(skipped, "learner");
		assert.equal(resSkipped.text, OK1);
		assert.deepEqual(resSkipped.details, { ok: true, requestedBy: "learner" });

		const ended: LhMessage[] = [
			userMsg("u1", T0),
			assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
			toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
			newBreakTakenMessage("sb1", 5, T0 + 700),
			newBreakEndedMessage("sb1", 300_000, "[Session note] back", T0 + 300_700),
		];
		const resEnded = await execSuggestBreak(ended, "learner", T0 + 301_000);
		assert.equal(resEnded.text, OK1);
		assert.deepEqual(resEnded.details, { ok: true, requestedBy: "learner" });
	});

	// plan 002 part 3: a window request with an open window, a teach tag and no open question returns OK1 and ok true
	it("allows requestedBy window when window is open, teaching has started, and no question is open", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			windowNote(T0 + 1000),
			...answeredQuiz("q1", T0 + 2000),
		];
		const res = await execSuggestBreak(messages, "window");
		assert.equal(res.text, OK1);
		assert.deepEqual(res.details, { ok: true, requestedBy: "window" });
	});

	// plan 011 part 2: suggest_break gains oneMoreQuestion?: boolean with requestedBy "window", and its result details carry it
	it("round-trips oneMoreQuestion true and false in details for requestedBy window", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			windowNote(T0 + 1000),
			...answeredQuiz("q1", T0 + 2000),
		];
		const resTrue = await execSuggestBreak(messages, "window", T0 + 60_000, true);
		assert.equal(resTrue.text, OK1);
		assert.deepEqual(resTrue.details, { ok: true, requestedBy: "window", oneMoreQuestion: true });

		const resFalse = await execSuggestBreak(messages, "window", T0 + 60_000, false);
		assert.equal(resFalse.text, OK1);
		assert.deepEqual(resFalse.details, { ok: true, requestedBy: "window", oneMoreQuestion: false });
	});

	// plan 011 part 2: with requestedBy "learner", oneMoreQuestion is refused with R5
	it("refuses oneMoreQuestion true with requestedBy learner using R5", async () => {
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			windowNote(T0 + 1000),
			...answeredQuiz("q1", T0 + 2000),
		];
		const res = await execSuggestBreak(messages, "learner", T0 + 60_000, true);
		assert.equal(res.text, R5);
		assert.deepEqual(res.details, { ok: false });

		const resFalse = await execSuggestBreak(messages, "learner", T0 + 60_000, false);
		assert.equal(resFalse.text, R5);
		assert.deepEqual(resFalse.details, { ok: false });
	});

	// plan 011 part 2: the window guards stay (window open, teaching started, no open question, no pending offer)
	it("keeps window guards active when oneMoreQuestion is true", async () => {
		const noWindow = await execSuggestBreak([userMsg("u1", T0), ...answeredQuiz("q1", T0 + 1000)], "window", T0 + 60_000, true);
		assert.equal(noWindow.text, R1);
		assert.deepEqual(noWindow.details, { ok: false });

		const openQuestion = await execSuggestBreak(
			[userMsg("u1", T0), windowNote(T0 + 1000), teachQuizCall("a1", "q1", T0 + 2000)],
			"window",
			T0 + 60_000,
			true,
		);
		assert.equal(openQuestion.text, R3);
		assert.deepEqual(openQuestion.details, { ok: false });

		const noTeach = await execSuggestBreak([userMsg("u1", T0), windowNote(T0 + 1000)], "window", T0 + 60_000, true);
		assert.equal(noTeach.text, R2);
		assert.deepEqual(noTeach.details, { ok: false });

		const pending = await execSuggestBreak(
			[
				userMsg("u1", T0),
				assistantCall("a_sb", "sb1", "suggest_break", { requestedBy: "learner" }, T0 + 500),
				toolResultMsg("r_sb", "sb1", "suggest_break", { ok: true, requestedBy: "learner" }, T0 + 600),
				newBreakTakenMessage("sb1", 5, T0 + 700),
				windowNote(T0 + 1000),
				...answeredQuiz("q1", T0 + 2000),
			],
			"window",
			T0 + 60_000,
			true,
		);
		assert.equal(pending.text, R4);
		assert.deepEqual(pending.details, { ok: false });
	});
});
