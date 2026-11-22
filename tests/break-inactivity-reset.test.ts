import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakState, breakTimings, learningClock } from "../src/core/breaks.ts";
import { newUserMessage, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";
import { BREAK_DEFAULTS, BREAK_RESET_RANGE, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseBreaksSettingsBody } from "../src/server/settings-body.ts";

const MIN = 60_000;
const SEC = 1_000;

const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 });

const userAt = (id: string, timestamp: number): LhMessage => ({
	...newUserMessage(`msg_${id}`),
	id,
	timestamp,
});

const steerAt = (id: string, timestamp: number): LhMarkerMessage => ({
	id,
	role: "custom",
	customType: "subagent-steer",
	content: "steer",
	display: false,
	details: null,
	timestamp,
});

const suggestBreakPair = (
	callId: string,
	requestedBy: "window" | "learner",
	timestamp: number,
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
		content: [{ type: "text", text: "ok" }],
		details: { ok: true },
		isError: false,
		timestamp,
	}) as never,
];

describe("breakTimings resetMs", () => {
	// plan 004 part 1: breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 }).resetMs -> 900 000; lengthMs stays 600 000
	it("computes resetMs = resetMinutes * 60_000 and keeps lengthMs", () => {
		assert.equal(TIMINGS.resetMs, 900_000);
		assert.equal(TIMINGS.lengthMs, 600_000);
	});
});

describe("learningClock inactivity reset", () => {
	// plan 004 part 1: with length 10 and reset 15, a 12-min gap between learner actions does not reset the clock; a 15-min gap does
	it("does not reset on a 12-min gap and resets on a 15-min gap when length is 10 and reset is 15", () => {
		const gap12 = [userAt("u1", 0), userAt("u2", 12 * MIN)];
		assert.deepEqual(learningClock(gap12, undefined, TIMINGS, 20 * MIN), {
			learningMs: 20 * MIN,
			startedAt: 0,
			awayMs: null,
		});

		const gap15 = [userAt("u1", 0), userAt("u2", 15 * MIN)];
		assert.deepEqual(learningClock(gap15, undefined, TIMINGS, 20 * MIN), {
			learningMs: 5 * MIN,
			startedAt: 15 * MIN,
			awayMs: null,
		});
	});

	// plan 004 part 1: learningClock at now = activity end + 14 min 59 s gives awayMs: null; at + 15 min, awayMs 15 min and learningMs 0
	it("returns awayMs null at +14m59s and awayMs 15m, learningMs 0 at +15m", () => {
		const msgs = [userAt("u1", 0)];
		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 14 * MIN + 59 * SEC), {
			learningMs: 14 * MIN + 59 * SEC,
			startedAt: 0,
			awayMs: null,
		});

		const away = learningClock(msgs, undefined, TIMINGS, 15 * MIN);
		assert.equal(away.awayMs, 15 * MIN);
		assert.equal(away.learningMs, 0);
	});
});

describe("breakState inactivity reset", () => {
	// plan 004 part 1: breakState with an open offer is pending at activity end + 14 min 59 s and skipped at + 15 min (reset 15, length 10)
	it("keeps an open offer pending at +14m59s and marks it skipped at +15m", () => {
		const msgs: LhMessage[] = [
			userAt("u1", 0),
			...suggestBreakPair("call_1", "window", 4 * MIN),
		];
		const beforeReset = breakState(msgs, undefined, TIMINGS, true, 4 * MIN + 14 * MIN + 59 * SEC);
		assert.equal(beforeReset.latest?.outcome, "pending");

		const atReset = breakState(msgs, undefined, TIMINGS, true, 4 * MIN + 15 * MIN);
		assert.equal(atReset.latest?.outcome, "skipped");
	});

	// plan 004 part 1: breakState's replayClock call site uses resetMs: a 12-min gap between learner actions does not reset (skip count kept), a 15-min gap does (length 10, reset 15)
	it("keeps the skip count over a 12-min gap and resets it over a 15-min gap", () => {
		const build = (secondActionAt: number): LhMessage[] => [
			userAt("u1", 0),
			...suggestBreakPair("call_1", "window", 1 * MIN),
			userAt("u2", secondActionAt),
		];

		const gap12 = breakState(build(13 * MIN), undefined, TIMINGS, true, 13 * MIN);
		assert.equal(gap12.latest?.outcome, "skipped");
		assert.equal(gap12.skipsInRow, 1);

		const gap15 = breakState(build(16 * MIN), undefined, TIMINGS, true, 16 * MIN);
		assert.equal(gap15.skipsInRow, 0);
	});
});

describe("learningClock running turn", () => {
	// plan 004 part 1: learner action at 0, no reply yet, now = 20 min, reset 15: without opts -> awayMs 20 min; with { turnRunning: true } -> awayMs: null, learningMs 20 min
	it("counts a learner-triggered running turn as activity and keeps awayMs null", () => {
		const msgs = [userAt("u1", 0)];

		const withoutOpts = learningClock(msgs, undefined, TIMINGS, 20 * MIN);
		assert.equal(withoutOpts.awayMs, 20 * MIN);
		assert.equal(withoutOpts.learningMs, 0);

		const withFalse = learningClock(msgs, undefined, TIMINGS, 20 * MIN, { turnRunning: false });
		assert.equal(withFalse.awayMs, 20 * MIN);
		assert.equal(withFalse.learningMs, 0);

		assert.deepEqual(learningClock(msgs, undefined, TIMINGS, 20 * MIN, { turnRunning: true }), {
			learningMs: 20 * MIN,
			startedAt: 0,
			awayMs: null,
		});
	});

	// plan 004 part 1: transcript whose last trigger is an automatic wake at 2 (learner action at 0), now 20, turnRunning: true -> awayMs 20 min
	it("does not extend activity when the last trigger is an automatic wake even with turnRunning true", () => {
		const msgs: LhMessage[] = [userAt("u1", 0), steerAt("s1", 2 * MIN)];
		const clock = learningClock(msgs, undefined, TIMINGS, 20 * MIN, { turnRunning: true });
		assert.equal(clock.awayMs, 20 * MIN);
		assert.equal(clock.learningMs, 0);
	});
});

describe("resetMinutes settings", () => {
	// plan 004 part 1: BREAK_DEFAULTS gains resetMinutes: 15; BREAK_RESET_RANGE = { min: 5, max: 60, step: 1 }
	it("exports BREAK_DEFAULTS.resetMinutes = 15 and BREAK_RESET_RANGE = { min: 5, max: 60, step: 1 }", () => {
		assert.equal(BREAK_DEFAULTS.resetMinutes, 15);
		assert.deepEqual(BREAK_RESET_RANGE, { min: 5, max: 60, step: 1 });
	});

	// plan 004 part 1: sanitizeBreaks with resetMinutes 3 -> 5, 75 -> 60, 12.4 -> 12, "x" -> dropped
	it("sanitizes resetMinutes by clamping to [5, 60], rounding, and dropping invalid values", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 3 } })?.breaks, { resetMinutes: 5 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 75 } })?.breaks, { resetMinutes: 60 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 12.4 } })?.breaks, { resetMinutes: 12 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 12.6 } })?.breaks, { resetMinutes: 13 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 5 } })?.breaks, { resetMinutes: 5 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: 60 } })?.breaks, { resetMinutes: 60 });

		for (const bad of ["x", "15", NaN, Infinity, -Infinity, null, true, {}]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { resetMinutes: bad } })?.breaks, {});
		}
	});

	// plan 004 part 1: resolution without resetMinutes -> 15
	it("resolves missing resetMinutes to 15 and honors explicit values", () => {
		assert.equal(resolveSettings(null).breaks.resetMinutes, 15);
		assert.equal(resolveSettings({ version: 1, breaks: {} }).breaks.resetMinutes, 15);
		assert.equal(resolveSettings({ version: 1, breaks: { resetMinutes: 30 } }).breaks.resetMinutes, 30);
	});

	// plan 004 part 1: parseBreaksSettingsBody({ resetMinutes: 4 }), 61, 12.5 -> error; 30 -> ok
	it("validates resetMinutes strictly in parseBreaksSettingsBody", () => {
		const expectedError = "resetMinutes must be an integer between 5 and 60";
		for (const bad of [4, 61, 12.5, "15", null]) {
			assert.deepEqual(parseBreaksSettingsBody({ resetMinutes: bad }), {
				ok: false,
				error: expectedError,
			});
		}
		assert.deepEqual(parseBreaksSettingsBody({ resetMinutes: 30 }), {
			ok: true,
			settings: { resetMinutes: 30 },
		});
		assert.deepEqual(parseBreaksSettingsBody({ resetMinutes: 5 }), {
			ok: true,
			settings: { resetMinutes: 5 },
		});
		assert.deepEqual(parseBreaksSettingsBody({ resetMinutes: 60 }), {
			ok: true,
			settings: { resetMinutes: 60 },
		});
	});
});
