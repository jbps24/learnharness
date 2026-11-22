import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { breakState, breakTimings, dividerState } from "../src/core/breaks.ts";
import {
	newBreakEndedMessage,
	newBreakTakenMessage,
	newUserMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

const MIN = 60_000;
const SEC = 1_000;
const TIMINGS = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 10 });
const T0 = 1_700_000_000_000;

function offerAt30Min(callId = "call_1"): { messages: LhMessage[]; activityEnd: number } {
	const offerAt = T0 + 30 * MIN;
	const messages: LhMessage[] = [
		{ ...newUserMessage("hi"), id: "u1", timestamp: T0 },
		{
			id: `a_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: { requestedBy: "window" } }],
			stopReason: "toolUse",
			timestamp: offerAt,
		} as never,
		{
			id: `r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "suggest_break",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
			isError: false,
			timestamp: offerAt,
		} as never,
	];
	return { messages, activityEnd: offerAt };
}

describe("breakState away skip", () => {
	// plan 002 part 10: breakState(..., now = activity end + 9 min 59 s).latest.outcome -> "pending"; skipsInRow -> 0
	it("keeps a pending offer as pending at activity end + 9 min 59 s with skipsInRow 0", () => {
		const { messages, activityEnd } = offerAt30Min();
		const state = breakState(messages, undefined, TIMINGS, true, activityEnd + 9 * MIN + 59 * SEC);
		assert.equal(state.latest?.outcome, "pending");
		assert.equal(state.skipsInRow, 0);
	});

	// plan 002 part 10: breakState(..., now = activity end + 10 min).latest.outcome -> "skipped"; skipsInRow -> 0 after the away reset
	it("marks a pending offer as skipped at activity end + 10 min and keeps skipsInRow 0", () => {
		const { messages, activityEnd } = offerAt30Min();
		const state = breakState(messages, undefined, TIMINGS, true, activityEnd + 10 * MIN);
		assert.equal(state.latest?.outcome, "skipped");
		assert.equal(state.skipsInRow, 0);
	});

	// plan 002 part 10: with a break-taken marker for that call before the absence, the outcome stays "taken" at any now
	it("keeps outcome taken at any now when break-taken precedes the absence", () => {
		const { messages, activityEnd } = offerAt30Min("call_taken");
		const takenAt = activityEnd + 1 * SEC;
		const withTaken = [...messages, newBreakTakenMessage("call_taken", 10, takenAt)];

		assert.equal(breakState(withTaken, undefined, TIMINGS, true, takenAt + 10 * MIN).latest?.outcome, "taken");
		assert.equal(breakState(withTaken, undefined, TIMINGS, true, takenAt + 60 * MIN).latest?.outcome, "taken");
	});

	// plan 002 part 10: with a break-ended marker for that call before the absence, the outcome stays "ended" at any now
	it("keeps outcome ended at any now when break-ended precedes the absence", () => {
		const { messages, activityEnd } = offerAt30Min("call_ended");
		const takenAt = activityEnd + 1 * SEC;
		const endedAt = takenAt + 10 * MIN;
		const withEnded = [
			...messages,
			newBreakTakenMessage("call_ended", 10, takenAt),
			newBreakEndedMessage("call_ended", 10 * MIN, "Back from break.", endedAt),
		];

		assert.equal(breakState(withEnded, undefined, TIMINGS, true, endedAt + 10 * MIN).latest?.outcome, "ended");
		assert.equal(breakState(withEnded, undefined, TIMINGS, true, endedAt + 60 * MIN).latest?.outcome, "ended");
	});
});

describe("dividerState", () => {
	// plan 002 part 10: dividerState("offered", true) -> "skipped"; ("offered", false) -> "offered"; ("taken", true) -> "taken"; ("ended", true) -> "ended"; ("skipped", false) -> "skipped"
	it("maps offered to skipped when away and preserves all other states", () => {
		assert.equal(dividerState("offered", true), "skipped");
		assert.equal(dividerState("offered", false), "offered");
		assert.equal(dividerState("taken", true), "taken");
		assert.equal(dividerState("ended", true), "ended");
		assert.equal(dividerState("skipped", false), "skipped");
	});
});

describe("POST /api/chats/[id]/break after absence", () => {
	let tmpDir: string;
	let POST: typeof import("../app/api/chats/[id]/break/route.ts").POST;
	let stores: typeof import("../src/server/index.ts").stores;

	before(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-break-away-skip-"));
		process.env.LH_DATA_DIR = tmpDir;
		({ POST } = await import("../app/api/chats/[id]/break/route.ts"));
		({ stores } = await import("../src/server/index.ts"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// plan 002 part 10: the break route Take after the absence -> 400 { error: "No break offer is open." }
	it("returns 400 No break offer is open on Take after the absence", async () => {
		const chat = stores.chatStore.createChat("Away skip route");
		const oldNow = Date.now() - 15 * MIN;
		const callId = "call_away";
		stores.chatStore.saveMessages(chat.id, [
			{ ...newUserMessage("hi"), id: "u_away", timestamp: oldNow - 30 * MIN },
			{
				id: `a_${callId}`,
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "suggest_break", arguments: { requestedBy: "window" } }],
				stopReason: "toolUse",
				timestamp: oldNow,
			} as never,
			{
				id: `r_${callId}`,
				role: "toolResult",
				toolCallId: callId,
				toolName: "suggest_break",
				content: [{ type: "text", text: "ok" }],
				details: { ok: true },
				isError: false,
				timestamp: oldNow,
			} as never,
		]);

		const res = await POST(
			new Request(`http://test/api/chats/${chat.id}/break`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "take", toolCallId: callId } }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "No break offer is open." });
	});
});
