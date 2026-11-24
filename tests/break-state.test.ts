import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakCountdown, breakNotesFor, breakState, breakTimings } from "../src/core/breaks.ts";
import {
	newBreakEndedMessage,
	newBreakNoteMessage,
	newBreakSkippedMessage,
	newBreakTakenMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 10 });

const WINDOW_TEXT =
	'[Session note] The learner has been learning for about 45 minutes. At the next closed point, suggest a short break: say so in one line, then call suggest_break with requestedBy "window" and end your turn. A closed point is a node end (its check answered correctly, no repair pending) or, better, a unit end; if the current node is the last of its unit, wait for the unit end. Never break mid-step or during a repair.';
const ESCALATION_TEXT =
	"[Session note] A break is overdue. Suggest it at the very next closed point, a node end included; don't hold out for the unit end.";

const userAt = (id: string, timestamp: number): LhMessage => ({
	...newUserMessage(`u_${id}`),
	id,
	timestamp,
});

/** Learner actions every 8 minutes from `from` up to and including `to`, so no gap reaches the 10-minute break length. */
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
	requestedBy: "window" | "learner",
	timestamp: number,
	ok = true,
): LhMessage[] => [
	({
		id: `a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: { requestedBy } }],
		stopReason: "toolUse",
		timestamp,
	}) as never,
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "suggest_break",
		content: [{ type: "text", text: ok ? "ok" : "error" }],
		details: { ok },
		isError: !ok,
		timestamp,
	}) as never,
];

const lessonRecordMarker = (id: string, firstKeptMessageId: string, timestamp: number): LhMarkerMessage => ({
	id,
	role: "custom",
	customType: "lesson-record",
	content: "lesson record",
	display: false,
	details: { firstKeptMessageId, finishedUnitIds: ["u1"], currentUnitId: "u2" },
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

describe("breakCountdown", () => {
	// plan 002 part 2: breakCountdown(0, 10, 19_000) -> "9:41"; at 683_000 -> "+1:23", over: true, progress: 1
	it("formats remaining time as 9:41 and elapsed past end as +1:23 with over true and progress capped at 1", () => {
		assert.deepEqual(breakCountdown(0, 10, 19_000), {
			label: "9:41",
			over: false,
			progress: 19_000 / 600_000,
		});
		assert.deepEqual(breakCountdown(0, 10, 683_000), {
			label: "+1:23",
			over: true,
			progress: 1,
		});
	});
});

describe("breakState", () => {
	// plan 002 part 2: no window before 40 min; nextOpenAtMs is intervalMs - leadMs
	it("has no window before 40 min and nextOpenAtMs 40 min when enabled", () => {
		const msgs = ticks(32, 0);
		const state = breakState(msgs, undefined, TIMINGS, true, 39 * MIN);
		assert.equal(state.window, null);
		assert.equal(state.latest, null);
		assert.equal(state.skipsInRow, 0);
		assert.equal(state.nextOpenAtMs, 40 * MIN);

		// plan 002 part 2: nextOpenAtMs is null when enabled is false
		const disabled = breakState(msgs, undefined, TIMINGS, false, 39 * MIN);
		assert.equal(disabled.nextOpenAtMs, null);
	});

	// plan 002 part 2: window note at 41 opens window; ok suggest_break closes it and sets latest
	it("opens window on break-note at 41 min and closes it on ok suggest_break result", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const opened = breakState([...ticks(40, 0), note], undefined, TIMINGS, true, 42 * MIN);
		assert.deepEqual(opened.window, {
			id: note.id,
			openedAtMs: 41 * MIN,
			escalated: false,
			noteInContext: true,
		});

		const closed = breakState(
			[...ticks(40, 0), note, ...suggestBreakPair("sb_1", "window", 42 * MIN, true)],
			undefined,
			TIMINGS,
			true,
			43 * MIN,
		);
		assert.equal(closed.window, null);
		assert.deepEqual(closed.latest, {
			toolCallId: "sb_1",
			requestedBy: "window",
			outcome: "pending",
		});
	});

	// plan 002 part 2: a window stays open until an ok suggest_break result; a non-ok result neither closes it nor sets latest
	it("keeps the window open and latest null on a non-ok suggest_break result", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const state = breakState(
			[...ticks(40, 0), note, ...suggestBreakPair("sb_1", "window", 42 * MIN, false)],
			undefined,
			TIMINGS,
			true,
			43 * MIN,
		);
		assert.equal(state.window?.id, note.id);
		assert.equal(state.latest, null);
	});

	// plan 002 part 2: a window is open until a reset, whichever comes first (gap >= lengthMs, or break-ended)
	it("closes an open window on a gap reset and on a break-ended marker", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const afterGap = breakState([...ticks(40, 0), note, userAt("back", 60 * MIN)], undefined, TIMINGS, true, 61 * MIN);
		assert.equal(afterGap.window, null);

		const afterEnded = breakState(
			[...ticks(40, 0), note, newBreakEndedMessage("sb_1", 5 * MIN, "back", 45 * MIN)],
			undefined,
			TIMINGS,
			true,
			46 * MIN,
		);
		assert.equal(afterEnded.window, null);
	});

	// plan 002 part 2: window.openedAtMs is in learning time (note time minus the clock start)
	it("measures window.openedAtMs in learning time after a reset", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const msgs = [userAt("a", 0), userAt("b", 30 * MIN), userAt("c", 38 * MIN), note];
		const state = breakState(msgs, undefined, TIMINGS, true, 42 * MIN);
		assert.equal(state.window?.openedAtMs, 11 * MIN);
	});

	// plan 002 part 2: break-taken -> taken; break-ended -> ended and resets skipsInRow
	it("marks latest taken on break-taken and ended on break-ended", () => {
		const msgs: LhMessage[] = [
			...ticks(40, 0),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN),
			...suggestBreakPair("sb_1", "window", 42 * MIN),
			newBreakTakenMessage("sb_1", 10, 42 * MIN),
		];
		const taken = breakState(msgs, undefined, TIMINGS, true, 45 * MIN);
		assert.equal(taken.latest?.outcome, "taken");
		assert.equal(taken.latest?.takenAt, 42 * MIN);
		assert.equal(taken.latest?.lengthMinutes, 10);

		const ended = breakState(
			[...msgs, newBreakEndedMessage("sb_1", 10 * MIN, "back", 52 * MIN)],
			undefined,
			TIMINGS,
			true,
			53 * MIN,
		);
		assert.equal(ended.latest?.outcome, "ended");
		assert.equal(ended.latest?.breakMs, 10 * MIN);
		assert.equal(ended.skipsInRow, 0);
		assert.equal(ended.nextOpenAtMs, 40 * MIN);
	});

	// plan 002 part 2: break-skipped or later main-transcript learner action without Take -> skipped
	it("marks latest skipped on break-skipped or later main-transcript text message", () => {
		const base: LhMessage[] = [
			...ticks(40, 0),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN),
			...suggestBreakPair("sb_1", "window", 42 * MIN),
		];
		const explicit = breakState([...base, newBreakSkippedMessage("sb_1", 43 * MIN)], undefined, TIMINGS, true, 44 * MIN);
		assert.equal(explicit.latest?.outcome, "skipped");

		const implicit = breakState([...base, userAt("u2", 46 * MIN)], undefined, TIMINGS, true, 47 * MIN);
		assert.equal(implicit.latest?.outcome, "skipped");
	});

	// plan 002 part 2: only a main-transcript learner action skips implicitly; a side-chat user message does not
	it("does not skip a pending suggestion on a side-chat user message", () => {
		const msgs: LhMessage[] = [...ticks(8, 0), ...suggestBreakPair("sb_1", "learner", 9 * MIN)];
		const state = breakState(msgs, [sideThread(10 * MIN)], TIMINGS, true, 11 * MIN);
		assert.equal(state.latest?.outcome, "pending");
	});

	// plan 002 part 2: skipsInRow counts window-requested skips only; a learner-requested skip leaves nextOpenAtMs at intervalMs - leadMs
	it("does not count a skipped learner-requested suggestion", () => {
		const msgs: LhMessage[] = [
			...ticks(8, 0),
			...suggestBreakPair("sb_1", "learner", 9 * MIN),
			newBreakSkippedMessage("sb_1", 10 * MIN),
		];
		const state = breakState(msgs, undefined, TIMINGS, true, 11 * MIN);
		assert.equal(state.latest?.outcome, "skipped");
		assert.equal(state.skipsInRow, 0);
		assert.equal(state.nextOpenAtMs, 40 * MIN);
	});

	// plan 002 part 2: one skip at 46 -> nextOpenAtMs 66 min; two skips -> nextOpenAtMs null
	it("sets nextOpenAtMs to 66 min after one skip at 46 min and null after two skips", () => {
		const oneSkip: LhMessage[] = [
			...ticks(40, 0),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN),
			...suggestBreakPair("sb_1", "window", 42 * MIN),
			userAt("u2", 46 * MIN),
		];
		const s1 = breakState(oneSkip, undefined, TIMINGS, true, 47 * MIN);
		assert.equal(s1.skipsInRow, 1);
		assert.equal(s1.nextOpenAtMs, 66 * MIN);

		const twoSkips: LhMessage[] = [
			...oneSkip,
			...ticks(62, 54),
			newBreakNoteMessage("window", WINDOW_TEXT, undefined, 66 * MIN),
			...suggestBreakPair("sb_2", "window", 67 * MIN),
			newBreakSkippedMessage("sb_2", 68 * MIN),
		];
		const s2 = breakState(twoSkips, undefined, TIMINGS, true, 69 * MIN);
		assert.equal(s2.skipsInRow, 2);
		assert.equal(s2.nextOpenAtMs, null);
	});

	// plan 002 part 2: escalated is true when a kind "escalation" note exists for the window
	it("sets escalated when an escalation note exists for the window", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const esc = newBreakNoteMessage("escalation", ESCALATION_TEXT, note.id, 61 * MIN);
		const state = breakState(
			[...ticks(40, 0), note, ...ticks(60, 48), esc],
			undefined,
			TIMINGS,
			true,
			62 * MIN,
		);
		assert.equal(state.window?.escalated, true);
	});

	// plan 002 part 2: noteInContext is false when window newest note sits before model context start
	it("sets noteInContext false when lesson-record or compaction firstKeptMessageId is after window note", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const kept = userAt("u_kept", 42 * MIN);
		const rec = lessonRecordMarker("lr_1", kept.id, 43 * MIN);
		const stateRec = breakState([...ticks(40, 0), note, kept, rec], undefined, TIMINGS, true, 44 * MIN);
		assert.equal(stateRec.window?.noteInContext, false);

		const comp = newCompactionMarker("summary", {
			firstKeptMessageId: kept.id,
			tokensBefore: 1000,
			at: new Date(43 * MIN).toISOString(),
		});
		const stateComp = breakState([...ticks(40, 0), note, kept, comp], undefined, TIMINGS, true, 44 * MIN);
		assert.equal(stateComp.window?.noteInContext, false);
	});

	// plan 002 part 2: the newest (re-sent) note counts; at or after the context start it is in context
	it("sets noteInContext true when a re-sent window note sits after the context start", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const kept = userAt("u_kept", 42 * MIN);
		const rec = lessonRecordMarker("lr_1", kept.id, 43 * MIN);
		const resent = newBreakNoteMessage("window", WINDOW_TEXT, note.id, 44 * MIN);
		const state = breakState([...ticks(40, 0), note, kept, rec, resent], undefined, TIMINGS, true, 45 * MIN);
		assert.equal(state.window?.noteInContext, true);
	});

	// plan 002 part 2: the context start is the larger index of the newest lesson-record and newest compaction boundaries
	it("uses the larger of the lesson-record and compaction boundaries", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const kept = userAt("u_kept", 42 * MIN);
		const early = lessonRecordMarker("lr_1", "t32", 43 * MIN);
		const comp = newCompactionMarker("summary", {
			firstKeptMessageId: kept.id,
			tokensBefore: 1000,
			at: new Date(44 * MIN).toISOString(),
		});
		const early2 = newCompactionMarker("summary", {
			firstKeptMessageId: "t32",
			tokensBefore: 1000,
			at: new Date(44 * MIN).toISOString(),
		});
		const late = lessonRecordMarker("lr_2", kept.id, 44 * MIN);
		const a = breakState([...ticks(40, 0), note, kept, early, comp], undefined, TIMINGS, true, 45 * MIN);
		assert.equal(a.window?.noteInContext, false);
		const b = breakState([...ticks(40, 0), note, kept, early2, late], undefined, TIMINGS, true, 45 * MIN);
		assert.equal(b.window?.noteInContext, false);
	});
});

describe("breakNotesFor", () => {
	// plan 002 part 2: nothing before probe_done except away
	it("emits nothing before probe_done, but an away note when away", () => {
		assert.deepEqual(breakNotesFor(ticks(41, 0), undefined, TIMINGS, true, 42 * MIN), []);

		const away = breakNotesFor([userAt("u1", 0)], undefined, TIMINGS, true, 30 * MIN);
		assert.equal(away.length, 1);
		assert.equal(kindOf(away[0]), "away");
	});

	// plan 002 part 2: nothing while enabled is false except away
	it("emits nothing while enabled is false except away", () => {
		const withProbe = [...probeDoneMessages(0), ...ticks(41)];
		assert.deepEqual(breakNotesFor(withProbe, undefined, TIMINGS, false, 42 * MIN), []);

		const awayDisabled = breakNotesFor(withProbe, undefined, TIMINGS, false, 60 * MIN);
		assert.equal(awayDisabled.length, 1);
		assert.equal(kindOf(awayDisabled[0]), "away");
	});

	// plan 002 part 2: window note emitted once across two inputs with exact text
	it("emits window note once across two inputs with exact confirmed text", () => {
		const msgs = [...probeDoneMessages(0), ...ticks(40)];
		const first = breakNotesFor(msgs, undefined, TIMINGS, true, 40 * MIN);
		assert.equal(first.length, 1);
		assert.equal(first[0]?.customType, "break-note");
		assert.equal(first[0]?.content, WINDOW_TEXT);
		assert.deepEqual(first[0]?.details, { kind: "window", windowId: first[0]?.id });

		const sent = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 40 * MIN);
		const second = breakNotesFor([...msgs, sent, userAt("u3", 45 * MIN)], undefined, TIMINGS, true, 46 * MIN);
		assert.deepEqual(second, []);
	});

	// plan 002 part 2: no window note while the latest suggestion is pending or taken
	it("emits no window note while latest is pending or taken", () => {
		const base = [...probeDoneMessages(0), ...ticks(40), ...suggestBreakPair("sb_1", "learner", 41 * MIN)];
		assert.deepEqual(breakNotesFor(base, undefined, TIMINGS, true, 42 * MIN), []);

		const taken = [...base, newBreakTakenMessage("sb_1", 10, 41 * MIN)];
		assert.deepEqual(breakNotesFor(taken, undefined, TIMINGS, true, 42 * MIN), []);
	});

	// plan 002 part 2: escalation at opened + 20 and only once with exact text
	it("emits escalation note at openedAtMs + 20 min and only once", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const msgs = [...probeDoneMessages(0), ...ticks(40), note, ...ticks(56, 48)];
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS, true, 60 * MIN), []);

		const esc = breakNotesFor(msgs, undefined, TIMINGS, true, 61 * MIN);
		assert.equal(esc.length, 1);
		assert.equal(esc[0]?.content, ESCALATION_TEXT);
		assert.deepEqual(esc[0]?.details, { kind: "escalation", windowId: note.id });

		const sent = newBreakNoteMessage("escalation", ESCALATION_TEXT, note.id, 61 * MIN);
		const afterEsc = breakNotesFor([...msgs, sent, userAt("u3", 62 * MIN)], undefined, TIMINGS, true, 63 * MIN);
		assert.deepEqual(afterEsc, []);
	});

	// plan 002 part 2: re-send window note with same text and windowId when noteInContext is false
	it("re-sends window note after a context cut", () => {
		const note = newBreakNoteMessage("window", WINDOW_TEXT, undefined, 41 * MIN);
		const kept = userAt("u_kept", 42 * MIN);
		const rec = lessonRecordMarker("lr_1", kept.id, 43 * MIN);
		const msgs = [...probeDoneMessages(0), ...ticks(40), note, kept, rec];
		const notes = breakNotesFor(msgs, undefined, TIMINGS, true, 44 * MIN);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]?.content, WINDOW_TEXT);
		assert.deepEqual(notes[0]?.details, { kind: "window", windowId: note.id });
	});

	// plan 002 part 2: away note uses formatAway ("18 min", "2 h 14 min"); a 3-day old transcript returns only the away note
	it("formats away note for 18 min and 2 h 14 min, and returns only away note on 3-day old transcript", () => {
		const msgs = [...probeDoneMessages(0)];
		const away18 = breakNotesFor(msgs, undefined, TIMINGS, true, 18 * MIN + 2000);
		assert.equal(away18.length, 1);
		assert.equal(
			away18[0]?.content,
			"[Session note] The learner is back after 18 min away. If it helps, re-orient them in one line (where we are, what's next), then continue.",
		);

		const away134 = breakNotesFor(msgs, undefined, TIMINGS, true, (2 * 60 + 14) * MIN + 2000);
		assert.equal(away134.length, 1);
		assert.equal(
			away134[0]?.content,
			"[Session note] The learner is back after 2 h 14 min away. If it helps, re-orient them in one line (where we are, what's next), then continue.",
		);

		const away3d = breakNotesFor(msgs, undefined, TIMINGS, true, 3 * DAY);
		assert.equal(away3d.length, 1);
		assert.equal(kindOf(away3d[0]), "away");
	});

	// plan 002 part 2: no away note when the latest suggestion is taken
	it("emits no away note when the latest suggestion is taken", () => {
		const msgs = [
			...probeDoneMessages(0),
			...ticks(20, 8),
			...suggestBreakPair("sb_1", "learner", 20 * MIN),
			newBreakTakenMessage("sb_1", 10, 20 * MIN),
		];
		assert.deepEqual(breakNotesFor(msgs, undefined, TIMINGS, true, 35 * MIN), []);
	});

	// plan 002 part 2: away and window together, in that order
	it("emits away and window together in that order when both are due", () => {
		const zeroInterval = breakTimings({ intervalMinutes: 0, lengthMinutes: 10, resetMinutes: 10 });
		const msgs = [...probeDoneMessages(0)];
		const notes = breakNotesFor(msgs, undefined, zeroInterval, true, 15 * MIN);
		assert.equal(notes.length, 2);
		assert.equal(kindOf(notes[0]), "away");
		assert.equal(kindOf(notes[1]), "window");
	});
});
