import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakState, breakTimings, learningClock } from "../src/core/breaks.ts";
import { ChatInputError, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import {
	newBreakEndedMessage,
	newBreakSkippedMessage,
	newBreakTakenMessage,
	newUserMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

const MIN = 60_000;
const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10 });

function suggestBreakPair(callId: string, timestamp: number): LhMessage[] {
	return [
		{
			id: `a_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: { requestedBy: "window" } }],
			stopReason: "toolUse",
			timestamp,
		} as never,
		{
			id: `r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "suggest_break",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
			isError: false,
			timestamp,
		} as never,
	];
}

describe("parseChatInput break-continue", () => {
	// plan 002 part 4: ChatInput gains { type: "break-continue"; toolCallId: string } (parsed like retry-question)
	it("parses break-continue with a non-empty toolCallId", () => {
		assert.deepEqual(parseChatInput({ type: "break-continue", toolCallId: "call_1" }), {
			type: "break-continue",
			toolCallId: "call_1",
		});
	});

	// plan 002 part 4: break-continue requires a non-empty string toolCallId
	it("rejects break-continue without a valid toolCallId", () => {
		assert.throws(() => parseChatInput({ type: "break-continue" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "break-continue", toolCallId: "" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "break-continue", toolCallId: 42 }), ChatInputError);
	});
});

describe("inputAppends break-continue", () => {
	// plan 002 part 4: break-continue with no break suggestion throws ChatInputError("No break is running.")
	it("throws ChatInputError when there is no break suggestion", () => {
		const messages: LhMessage[] = [{ ...newUserMessage("hi"), id: "u1", timestamp: 0 }];
		assert.throws(
			() => inputAppends({ messages }, { type: "break-continue", toolCallId: "call_1" }, 5 * MIN),
			(err: unknown) => err instanceof ChatInputError && err.message === "No break is running.",
		);
	});

	// plan 002 part 4: break-continue before Take throws ChatInputError
	it("throws ChatInputError when the latest suggestion is still pending", () => {
		const messages: LhMessage[] = [
			{ ...newUserMessage("hi"), id: "u1", timestamp: 0 },
			...suggestBreakPair("call_1", 41 * MIN),
		];
		assert.throws(
			() => inputAppends({ messages }, { type: "break-continue", toolCallId: "call_1" }, 42 * MIN),
			(err: unknown) => err instanceof ChatInputError && err.message === "No break is running.",
		);
	});

	// plan 002 part 4: latest suggestion must be taken with that toolCallId
	it("throws ChatInputError when toolCallId does not match the taken break", () => {
		const messages: LhMessage[] = [
			{ ...newUserMessage("hi"), id: "u1", timestamp: 0 },
			...suggestBreakPair("call_1", 41 * MIN),
			newBreakTakenMessage("call_1", 10, 42 * MIN),
		];
		assert.throws(
			() => inputAppends({ messages }, { type: "break-continue", toolCallId: "call_other" }, 47 * MIN),
			(err: unknown) => err instanceof ChatInputError && err.message === "No break is running.",
		);
	});

	// plan 002 part 4: break-continue after Skip throws ChatInputError
	it("throws ChatInputError when the latest suggestion was skipped", () => {
		const messages: LhMessage[] = [
			{ ...newUserMessage("hi"), id: "u1", timestamp: 0 },
			...suggestBreakPair("call_1", 41 * MIN),
			newBreakSkippedMessage("call_1", 42 * MIN),
		];
		assert.throws(
			() => inputAppends({ messages }, { type: "break-continue", toolCallId: "call_1" }, 47 * MIN),
			(err: unknown) => err instanceof ChatInputError && err.message === "No break is running.",
		);
	});

	// plan 002 part 4: break-continue after already ended throws ChatInputError
	it("throws ChatInputError when the break has already ended", () => {
		const messages: LhMessage[] = [
			{ ...newUserMessage("hi"), id: "u1", timestamp: 0 },
			...suggestBreakPair("call_1", 41 * MIN),
			newBreakTakenMessage("call_1", 10, 42 * MIN),
			newBreakEndedMessage("call_1", 5 * MIN, "Back after 5:00.", 47 * MIN),
		];
		assert.throws(
			() => inputAppends({ messages }, { type: "break-continue", toolCallId: "call_1" }, 48 * MIN),
			(err: unknown) => err instanceof ChatInputError && err.message === "No break is running.",
		);
	});

	// plan 002 part 4: after Take it appends break-ended whose content says the break length (m:ss) and its breakMs; next breakState shows ended and a reset clock
	it("appends break-ended with m:ss and breakMs, and resets breakState/clock", () => {
		const takenAt = 42 * MIN;
		const now = 47 * MIN + 5_000;
		const expectedBreakMs = now - takenAt; // 5m 05s = 305_000 ms
		const messages: LhMessage[] = [
			{ ...newUserMessage("hi"), id: "u1", timestamp: 0 },
			...suggestBreakPair("call_1", 41 * MIN),
			newBreakTakenMessage("call_1", 10, takenAt),
		];

		const appends = inputAppends({ messages }, { type: "break-continue", toolCallId: "call_1" }, now);
		assert.equal(appends.length, 1);
		const ended = appends[0]!;
		assert.equal(ended.role, "custom");
		if (ended.role === "custom") {
			assert.equal(ended.customType, "break-ended");
			assert.ok(ended.content.includes("5:05"), `expected m:ss "5:05" in content: ${ended.content}`);
			assert.deepEqual(ended.details, { toolCallId: "call_1", breakMs: expectedBreakMs });
			assert.equal(ended.timestamp, now);
		}

		const nextMessages = [...messages, ...appends];
		const state = breakState(nextMessages, undefined, TIMINGS, true, now);
		assert.equal(state.latest?.outcome, "ended");
		assert.equal(state.latest?.breakMs, expectedBreakMs);
		assert.equal(state.window, null);
		assert.equal(state.skipsInRow, 0);

		const clock = learningClock(nextMessages, undefined, TIMINGS, now);
		assert.equal(clock.learningMs, 0);
		assert.equal(clock.startedAt, now);
	});
});
