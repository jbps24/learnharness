import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakTimings, learnerActivityTimes, learningClock } from "../src/core/breaks.ts";
import {
	newBreakEndedMessage,
	newBreakNoteMessage,
	newBreakTakenMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 10 });

const userAt = (id: string, timestamp: number): LhMessage => ({
	...newUserMessage(`msg_${id}`),
	id,
	timestamp,
});

const assistantAt = (id: string, timestamp: number, durationMs?: number): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp,
		...(durationMs !== undefined ? { durationMs } : {}),
	}) as never;

const steerAt = (id: string, timestamp: number): LhMarkerMessage => ({
	id,
	role: "custom",
	customType: "subagent-steer",
	content: "steer",
	display: false,
	details: null,
	timestamp,
});

const sideThread = (entries: Array<{ role: "user" | "assistant"; atMs: number }>): SideChatThread => ({
	id: "side_1",
	anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "block" },
	open: false,
	createdAt: new Date(0).toISOString(),
	messages: entries.map((e, i) => ({
		id: `sm_${i}`,
		role: e.role,
		text: "q",
		at: new Date(e.atMs).toISOString(),
	})),
});

describe("learnerActivityTimes", () => {
	// plan 002 part 2: learnerActivityTimes handles empty messages and undefined sideChats
	it("returns empty array for empty transcript and undefined sideChats", () => {
		assert.deepEqual(learnerActivityTimes([], undefined), []);
	});

	// plan 002 part 2: learnerActivityTimes includes nativeInputCause learner messages and side-chat user Date.parse(at), sorted
	it("collects learner-cause messages and user side-chat timestamps, sorted", () => {
		const msgs: LhMessage[] = [
			userAt("u1", 10 * MIN),
			assistantAt("a1", 11 * MIN),
			steerAt("s1", 12 * MIN),
			newBreakNoteMessage("window", "note", undefined, 13 * MIN),
			newBreakTakenMessage("c1", 10, 20 * MIN),
		];
		const side = [
			sideThread([
				{ role: "user", atMs: 15 * MIN },
				{ role: "assistant", atMs: 16 * MIN },
				{ role: "user", atMs: 5 * MIN },
			]),
		];
		assert.deepEqual(learnerActivityTimes(msgs, side), [5 * MIN, 10 * MIN, 15 * MIN, 20 * MIN]);
	});
});

describe("learningClock", () => {
	// plan 002 part 2: learningClock returns learningMs 0, startedAt null, awayMs null when no learner activity exists
	it("returns zero learningMs, null startedAt, and null awayMs on empty transcript", () => {
		assert.deepEqual(learningClock([], undefined, TIMINGS, 5 * MIN), {
			learningMs: 0,
			startedAt: null,
			awayMs: null,
		});
	});

	// plan 002 part 2: activity at 0, 10, 20 min and now at 25 -> learningMs 25 min
	it("sums continuous activity at 0, 10, 20 min with now at 25 min to 25 min", () => {
		const msgs = [userAt("u1", 0), assistantAt("a1", 1 * MIN), userAt("u2", 10 * MIN), assistantAt("a2", 11 * MIN), userAt("u3", 20 * MIN)];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 25 * MIN), {
			learningMs: 25 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	// plan 002 part 2: gap >= lengthMs (10 min) resets at returning action; 9-min gap does not
	it("resets on 12-min gap and exact 10-min gap, does not reset on 9-min gap", () => {
		const gap12 = [userAt("u1", 0), userAt("u2", 12 * MIN)];
		assert.deepEqual(learningClock(gap12, undefined, TIMINGS, 15 * MIN), {
			learningMs: 3 * MIN,
			startedAt: 12 * MIN,
			awayMs: null,
		});

		const gap10 = [userAt("u1", 0), userAt("u2", 10 * MIN)];
		assert.deepEqual(learningClock(gap10, undefined, TIMINGS, 15 * MIN), {
			learningMs: 5 * MIN,
			startedAt: 10 * MIN,
			awayMs: null,
		});

		const gap9 = [userAt("u1", 0), userAt("u2", 9 * MIN)];
		assert.deepEqual(learningClock(gap9, undefined, TIMINGS, 15 * MIN), {
			learningMs: 15 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	// plan 002 part 2: learner action at 0, reply ending at 4, next action at 13 -> gap 9, no reset
	it("extends activityEnd by assistant durationMs (reply-end rule)", () => {
		const msgs = [userAt("u1", 0), assistantAt("a1", 1 * MIN, 3 * MIN), userAt("u2", 13 * MIN)];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 15 * MIN), {
			learningMs: 15 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	// plan 002 part 2: assistant message without durationMs ends at its timestamp
	it("treats assistant without durationMs as ending at its timestamp", () => {
		const msgs = [userAt("u1", 0), assistantAt("a1", 4 * MIN), userAt("u2", 14 * MIN)];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 16 * MIN), {
			learningMs: 2 * MIN,
			startedAt: 14 * MIN,
			awayMs: null,
		});
	});

	// plan 002 part 2: subagent-steer wake at 8 with teacher reply at 8.5 does not end a gap from 2 to 14
	it("does not let automatic subagent-steer wake and its reply end a gap", () => {
		const msgs: LhMessage[] = [
			userAt("u1", 2 * MIN),
			steerAt("s1", 8 * MIN),
			assistantAt("a1", 8.5 * MIN, 1 * MIN),
			userAt("u2", 14 * MIN),
		];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 16 * MIN), {
			learningMs: 2 * MIN,
			startedAt: 14 * MIN,
			awayMs: null,
		});
	});

	// plan 002 part 2: side-chat user message at 7 ends a gap from 2 to 14
	it("counts side-chat user message as learner activity bridging a gap", () => {
		const msgs = [userAt("u1", 2 * MIN), userAt("u2", 14 * MIN)];
		const side = [sideThread([{ role: "user", atMs: 7 * MIN }])];
		assert.deepEqual(learningClock(msgs, side, TIMINGS, 16 * MIN), {
			learningMs: 14 * MIN,
			startedAt: 2 * MIN,
			awayMs: null,
		});
	});

	// plan 002 part 2: break-ended marker is a reset at its own time
	it("resets at break-ended marker timestamp", () => {
		const msgs: LhMessage[] = [
			userAt("u1", 0),
			newBreakEndedMessage("c1", 3 * MIN, "back", 5 * MIN),
		];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 8 * MIN), {
			learningMs: 3 * MIN,
			startedAt: 5 * MIN,
			awayMs: null,
		});
	});

	// plan 002 part 2: now 15 min after last activity gives awayMs 15 min and learningMs 0
	it("returns awayMs 15 min and learningMs 0 when now is 15 min after last activity", () => {
		const msgs = [userAt("u1", 0)];
		const clock = learningClock(msgs, undefined, TIMINGS, 15 * MIN);
		assert.equal(clock.learningMs, 0);
		assert.equal(clock.awayMs, 15 * MIN);
	});

	// plan 002 part 2: a tool-result of a learner-triggered turn extends activityEnd to timestamp + (durationMs ?? 0)
	it("extends activityEnd by a learner-triggered tool result, with and without durationMs", () => {
		const toolResultAt = (id: string, timestamp: number, durationMs?: number): LhMessage =>
			({
				id,
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "x",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp,
				...(durationMs !== undefined ? { durationMs } : {}),
			}) as never;
		const withDuration = [userAt("u1", 0), toolResultAt("r1", 1 * MIN, 3 * MIN), userAt("u2", 13 * MIN)];
		assert.deepEqual(learningClock(withDuration, undefined, TIMINGS, 15 * MIN), {
			learningMs: 15 * MIN,
			startedAt: 0,
			awayMs: null,
		});
		const withoutDuration = [userAt("u1", 0), toolResultAt("r1", 4 * MIN), userAt("u2", 14 * MIN)];
		assert.deepEqual(learningClock(withoutDuration, undefined, TIMINGS, 16 * MIN), {
			learningMs: 2 * MIN,
			startedAt: 14 * MIN,
			awayMs: null,
		});
	});

	// plan 002 part 2: old transcript whose last action is 3 days before now gives awayMs approx 3 days
	it("gives awayMs approx 3 days and learningMs 0 for old transcript without break markers", () => {
		const msgs = [userAt("u1", 0)];
		const clock = learningClock(msgs, undefined, TIMINGS, 3 * DAY);
		assert.equal(clock.learningMs, 0);
		assert.equal(clock.awayMs, 3 * DAY);
	});
});

describe("learningClock monotonicity", () => {
	it("does not move activityEnd backwards when a side-chat message falls within assistant durationMs", () => {
		const msgs = [userAt("u1", 0), assistantAt("a1", 1 * MIN, 4 * MIN), userAt("u2", 14 * MIN)];
		const side = [sideThread([{ role: "user", atMs: 3 * MIN }])];
		assert.deepEqual(learningClock(msgs, side, TIMINGS, 15 * MIN), {
			learningMs: 15 * MIN,
			startedAt: 0,
			awayMs: null,
		});
		assert.deepEqual(learningClock(msgs.slice(0, 2), side, TIMINGS, 14 * MIN), {
			learningMs: 14 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	it("does not move activityEnd backwards when a toolResult ends earlier than the preceding assistant durationMs", () => {
		const toolResultAt = (id: string, timestamp: number, durationMs?: number): LhMessage =>
			({
				id,
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "x",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp,
				...(durationMs !== undefined ? { durationMs } : {}),
			}) as never;
		const msgs = [userAt("u1", 0), assistantAt("a1", 1 * MIN, 4 * MIN), toolResultAt("r1", 2 * MIN, 1 * MIN), userAt("u2", 14 * MIN)];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 15 * MIN), {
			learningMs: 15 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	it("resets activityEnd to break-ended timestamp even if a prior reply extended past it", () => {
		const msgs: LhMessage[] = [
			userAt("u1", 0),
			assistantAt("a1", 1 * MIN, 10 * MIN),
			newBreakEndedMessage("c1", 3 * MIN, "back", 5 * MIN),
		];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 15 * MIN), {
			learningMs: 0,
			startedAt: 15 * MIN,
			awayMs: 10 * MIN,
		});
	});
});
