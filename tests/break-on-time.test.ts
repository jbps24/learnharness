import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakNotesFor, breakState, breakTimings } from "../src/core/breaks.ts";
import {
	newAnswerResult,
	newBreakNoteMessage,
	newBreakSkippedMessage,
	newThinkingMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";

const MIN = 60_000;
const TIMINGS_45 = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 10 });
const TIMINGS_60 = breakTimings({ intervalMinutes: 60, lengthMinutes: 10, resetMinutes: 10 });

const WINDOW_TEXT =
	'[Session note] The learner has been learning for about 45 minutes. In this turn, respond to their input in one line, then suggest a short break instead of going on: say so in one line, call suggest_break with requestedBy "window" and end your turn. Mid-node is fine. If exactly one question remains until the current node is closed, you may instead offer it first: say in one line that one question would close the node and ask whether they want to answer it before the break, then call suggest_break with requestedBy "window" and oneMoreQuestion true.';
const ESCALATION_TEXT =
	"[Session note] A break is overdue. In this turn, respond to the learner's input in one line, then suggest the break.";

const userAt = (id: string, timestamp: number): LhMessage => ({
	...newUserMessage(`u_${id}`),
	id,
	timestamp,
});

/** Learner actions every 8 minutes from `from` up to and including `to`, so no gap reaches the 10-minute reset. */
const ticks = (to: number, from = 0): LhMessage[] => {
	const minutes: number[] = [];
	for (let m = from; m < to; m += 8) minutes.push(m);
	minutes.push(to);
	return minutes.map((m) => userAt(`t${m}`, m * MIN));
};

const probeDoneMessages = (startAt = 0): LhMessage[] => [
	userAt("u_probe", startAt),
	({
		id: "a_probe",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_probe", name: "probe_done", arguments: {} }],
		stopReason: "toolUse",
		timestamp: startAt + 1000,
	}) as never,
	({
		id: "r_probe",
		role: "toolResult",
		toolCallId: "call_probe",
		toolName: "probe_done",
		content: [{ type: "text", text: "ok" }],
		details: { ok: true },
		isError: false,
		timestamp: startAt + 2000,
	}) as never,
];

const suggestBreakPair = (
	callId: string,
	args: { requestedBy: "window" | "learner"; oneMoreQuestion?: boolean },
	timestamp: number,
): LhMessage[] => [
	({
		id: `a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: args }],
		stopReason: "toolUse",
		timestamp,
	}) as never,
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "suggest_break",
		content: [{ type: "text", text: "ok" }],
		details: { ok: true },
		isError: false,
		timestamp,
	}) as never,
];

const quizCallAt = (callId: string, timestamp: number): LhMessage =>
	({
		id: `a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Q?", options: ["A", "B"] } }],
		stopReason: "toolUse",
		timestamp,
	}) as never;

const quizAnswerAt = (callId: string, timestamp: number): LhMessage => ({
	...newAnswerResult(callId, "quiz", {
		kind: "quiz",
		questionText: "Q?",
		dontKnow: false,
		answers: ["A"],
		answeredAt: new Date(timestamp).toISOString(),
	}),
	timestamp,
});

const sideThread = (userAtMs: number): SideChatThread => ({
	id: "side_1",
	anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "block" },
	open: false,
	createdAt: new Date(0).toISOString(),
	messages: [{ id: "sm_0", role: "user", text: "q", at: new Date(userAtMs).toISOString() }],
});

const kindOf = (m: LhMarkerMessage | undefined) => (m?.details as { kind?: string } | undefined)?.kind;

describe("break window opening on time", () => {
	// plan 011 part 1: the window opens at 45:00 and not at 40:00 (interval 45)
	it("opens at 45:00 and not at 40:00 for interval 45", () => {
		const msgs = [...probeDoneMessages(0), ...ticks(40)];
		assert.equal(breakState(msgs, undefined, TIMINGS_45, true, 40 * MIN).nextOpenAtMs, 45 * MIN);
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS_45, true, 40 * MIN), []);
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS_45, true, 44 * MIN), []);

		const at45 = breakNotesFor([...msgs, userAt("u45", 45 * MIN)], undefined, TIMINGS_45, true, 45 * MIN);
		assert.equal(at45.length, 1);
		assert.equal(kindOf(at45[0]), "window");
	});

	// plan 011 part 1: the window opens at 60:00 for interval 60
	it("opens at 60:00 and not at 59:00 for interval 60", () => {
		const msgs = [...probeDoneMessages(0), ...ticks(56)];
		assert.equal(breakState(msgs, undefined, TIMINGS_60, true, 59 * MIN).nextOpenAtMs, 60 * MIN);
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS_60, true, 59 * MIN), []);

		const at60 = breakNotesFor([...msgs, userAt("u60", 60 * MIN)], undefined, TIMINGS_60, true, 60 * MIN);
		assert.equal(at60.length, 1);
		assert.equal(kindOf(at60[0]), "window");
	});
});

describe("window-requested skips and unlimited re-offers", () => {
	// plan 011 part 1: a skip at 50 min re-offers at 70 min, a second and a third skip still re-offer 20 min after each
	it("re-offers 20 min after 1st, 2nd, and 3rd skips without ever setting nextOpenAtMs to null", () => {
		const skip1: LhMessage[] = [
			...probeDoneMessages(0),
			...ticks(45),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN),
			...suggestBreakPair("sb_1", { requestedBy: "window" }, 46 * MIN),
			newBreakSkippedMessage("sb_1", 50 * MIN),
		];
		const s1 = breakState(skip1, undefined, TIMINGS_45, true, 51 * MIN);
		assert.equal(s1.skipsInRow, 1);
		assert.equal(s1.nextOpenAtMs, 70 * MIN);
		assert.deepEqual(breakNotesFor([...skip1, ...ticks(66, 58)], undefined, TIMINGS_45, true, 69 * MIN), []);
		assert.equal(kindOf(breakNotesFor([...skip1, ...ticks(70, 58)], undefined, TIMINGS_45, true, 70 * MIN)[0]), "window");

		const skip2: LhMessage[] = [
			...skip1,
			...ticks(66, 58),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 70 * MIN),
			...suggestBreakPair("sb_2", { requestedBy: "window" }, 71 * MIN),
			newBreakSkippedMessage("sb_2", 72 * MIN),
		];
		const s2 = breakState(skip2, undefined, TIMINGS_45, true, 73 * MIN);
		assert.equal(s2.skipsInRow, 2);
		assert.equal(s2.nextOpenAtMs, 92 * MIN);

		const skip3: LhMessage[] = [
			...skip2,
			...ticks(88, 80),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 92 * MIN),
			...suggestBreakPair("sb_3", { requestedBy: "window" }, 93 * MIN),
			newBreakSkippedMessage("sb_3", 94 * MIN),
		];
		const s3 = breakState(skip3, undefined, TIMINGS_45, true, 95 * MIN);
		assert.equal(s3.skipsInRow, 3);
		assert.equal(s3.nextOpenAtMs, 114 * MIN);
	});

	// plan 011 part 1: implicit skip by main-transcript learner action sets nextOpenAtMs = skip learning time + reofferMs
	it("re-offers 20 min after an implicit skip on a learner action", () => {
		const msgs: LhMessage[] = [
			...probeDoneMessages(0),
			...ticks(45),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN),
			...suggestBreakPair("sb_1", { requestedBy: "window" }, 46 * MIN),
			userAt("u_skip", 50 * MIN),
		];
		const state = breakState(msgs, undefined, TIMINGS_45, true, 51 * MIN);
		assert.equal(state.latest?.outcome, "skipped");
		assert.equal(state.skipsInRow, 1);
		assert.equal(state.nextOpenAtMs, 70 * MIN);
	});
});

describe("one-more-question skip", () => {
	// plan 011 part 1: a one-more-question skip at 46 min makes the window due at once, its note rides the next answer input and not a text input, and skipsInRow stays 0
	it("keeps skipsInRow 0, sets nextOpenAtMs to skip time, and appends window note to answer but not text", () => {
		const base: LhMessage[] = [
			...probeDoneMessages(0),
			...ticks(45),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN),
			...suggestBreakPair("sb_1", { requestedBy: "window", oneMoreQuestion: true }, 45 * MIN),
			newBreakSkippedMessage("sb_1", 46 * MIN),
		];
		const state = breakState(base, undefined, TIMINGS_45, true, 46 * MIN);
		assert.equal(state.latest?.outcome, "skipped");
		assert.equal(state.skipsInRow, 0);
		assert.equal(state.nextOpenAtMs, 46 * MIN);

		// Does not ride a text input
		const withText = [...base, userAt("u_text", 47 * MIN)];
		assert.deepEqual(breakNotesFor(withText, undefined, TIMINGS_45, true, 47 * MIN), []);

		// Rides the next answer input
		const withAnswer = [...withText, quizCallAt("q_1", 47 * MIN + 1000), quizAnswerAt("q_1", 48 * MIN)];
		const onAnswer = breakNotesFor(withAnswer, undefined, TIMINGS_45, true, 48 * MIN);
		assert.equal(onAnswer.length, 1);
		assert.equal(kindOf(onAnswer[0]), "window");
	});

	// plan 011 part 1: also rides thinking and plugin-problem-submission inputs
	it("appends window note after a one-more-question skip to thinking and plugin-problem-submission inputs", () => {
		const base: LhMessage[] = [
			...probeDoneMessages(0),
			...ticks(45),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN),
			...suggestBreakPair("sb_1", { requestedBy: "window", oneMoreQuestion: true }, 45 * MIN),
			newBreakSkippedMessage("sb_1", 46 * MIN),
		];

		const withThinking = [...base, { ...newThinkingMessage("prob_1", "my work"), timestamp: 47 * MIN }];
		const onThinking = breakNotesFor(withThinking, undefined, TIMINGS_45, true, 47 * MIN);
		assert.equal(onThinking.length, 1);
		assert.equal(kindOf(onThinking[0]), "window");

		const pluginSub: LhMarkerMessage = {
			id: "ps_1",
			role: "custom",
			customType: "plugin-problem-submission",
			content: "submission",
			display: true,
			details: { problemId: "p1", submission: {} },
			timestamp: 47 * MIN,
		};
		const onPluginSub = breakNotesFor([...base, pluginSub], undefined, TIMINGS_45, true, 47 * MIN);
		assert.equal(onPluginSub.length, 1);
		assert.equal(kindOf(onPluginSub[0]), "window");
	});
});

describe("escalation via answeredSince", () => {
	// plan 011 part 1: escalation rides the first learner input after the window note when no suggestion came, and only once
	it("sets answeredSince on main-transcript learner action after window note and emits escalation once", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN);
		const opened = [...probeDoneMessages(0), ...ticks(45), note];

		assert.equal(breakState(opened, undefined, TIMINGS_45, true, 46 * MIN).window?.answeredSince, false);
		assert.deepEqual(breakNotesFor(opened, undefined, TIMINGS_45, true, 46 * MIN), []);

		// Side-chat action does not count as main-transcript learner action
		assert.equal(breakState(opened, [sideThread(47 * MIN)], TIMINGS_45, true, 48 * MIN).window?.answeredSince, false);
		assert.deepEqual(breakNotesFor(opened, [sideThread(47 * MIN)], TIMINGS_45, true, 48 * MIN), []);

		// First main-transcript learner action triggers escalation
		const afterInput = [...opened, userAt("u_after", 48 * MIN)];
		assert.equal(breakState(afterInput, undefined, TIMINGS_45, true, 48 * MIN).window?.answeredSince, true);
		const esc = breakNotesFor(afterInput, undefined, TIMINGS_45, true, 48 * MIN);
		assert.equal(esc.length, 1);
		assert.equal(kindOf(esc[0]), "escalation");
		assert.equal(esc[0]?.content, ESCALATION_TEXT);

		// Only once
		const sentEsc = newBreakNoteMessage("escalation", ESCALATION_TEXT, note.id, 48 * MIN);
		const later = [...afterInput, sentEsc, userAt("u_later", 50 * MIN)];
		assert.deepEqual(breakNotesFor(later, undefined, TIMINGS_45, true, 50 * MIN), []);
	});

	// plan 011 part 1: answeredSince is true when a learner action exists after the window's newest note (a re-sent note resets it)
	it("measures answeredSince from the newest (re-sent) window note", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN);
		const resent = newBreakNoteMessage("window", WINDOW_TEXT, note.id, 49 * MIN);
		const msgs = [...probeDoneMessages(0), ...ticks(45), note, userAt("u_before", 47 * MIN), resent];
		assert.equal(breakState(msgs, undefined, TIMINGS_45, true, 50 * MIN).window?.answeredSince, false);
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS_45, true, 50 * MIN), []);

		const after = [...msgs, userAt("u_after", 51 * MIN)];
		assert.equal(breakState(after, undefined, TIMINGS_45, true, 51 * MIN).window?.answeredSince, true);
	});

	// plan 011 part 1: no escalation while a suggestion is pending
	it("emits no escalation while a suggestion is pending", () => {
		const msgs: LhMessage[] = [
			...probeDoneMessages(0),
			...ticks(45),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 45 * MIN),
			...suggestBreakPair("sb_1", { requestedBy: "window" }, 46 * MIN),
		];
		const state = breakState(msgs, undefined, TIMINGS_45, true, 47 * MIN);
		assert.equal(state.window, null);
		assert.equal(state.latest?.outcome, "pending");
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS_45, true, 47 * MIN), []);
	});
});
