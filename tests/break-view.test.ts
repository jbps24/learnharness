import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectView, type LhViewPart } from "../src/core/view.ts";
import {
	newBreakEndedMessage,
	newBreakNoteMessage,
	newBreakSkippedMessage,
	newBreakTakenMessage,
	newUserMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

const MIN = 60_000;

const userAt = (id: string, text: string, timestamp: number): LhMessage => ({
	...newUserMessage(text),
	id,
	timestamp,
});

const suggestBreakCall = (callId: string, timestamp: number, ok = true, isError = !ok, oneMoreQuestion?: boolean): LhMessage[] => [
	({
		id: `a_${callId}`,
		role: "assistant",
		content: [{
			type: "toolCall",
			id: callId,
			name: "suggest_break",
			arguments: oneMoreQuestion ? { requestedBy: "window", oneMoreQuestion: true } : { requestedBy: "window" },
		}],
		stopReason: "toolUse",
		timestamp,
	}) as never,
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "suggest_break",
		content: [{ type: "text", text: ok ? "ok" : "refused" }],
		details: { ok },
		isError,
		timestamp: timestamp + 100,
	}) as never,
];

const breakPartsOf = (messages: readonly LhMessage[]): LhViewPart[] =>
	projectView(messages).flatMap((m) => m.parts.filter((p) => p.type === "data-break"));

describe("projectView data-break", () => {
	// plan 002 part 6: an ok suggest_break tool call projects { type: "data-break", id: "br_<toolCallId>", data: { toolCallId, state: "offered" } }
	it("emits one data-break with state offered for an ok suggest_break call", () => {
		const msgs = [...suggestBreakCall("c1", 10 * MIN)];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.equal(parts[0]!.id, "br_c1");
		assert.deepEqual(parts[0]!.data, { toolCallId: "c1", state: "offered" });
	});

	// plan 002 part 6: break-taken moves data-break to taken with takenAt and lengthMinutes from the saved marker
	it("follows break-taken to state taken with takenAt and lengthMinutes", () => {
		const takenAt = 11 * MIN;
		const msgs = [
			...suggestBreakCall("c1", 10 * MIN),
			newBreakTakenMessage("c1", 10, takenAt),
		];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.deepEqual(parts[0]!.data, {
			toolCallId: "c1",
			state: "taken",
			takenAt,
			lengthMinutes: 10,
		});
	});

	// plan 002 part 6: projecting the same saved messages again (a restart) gives the same takenAt and lengthMinutes
	it("produces identical takenAt and lengthMinutes when re-projecting saved messages", () => {
		const takenAt = 11 * MIN;
		const msgs = [
			...suggestBreakCall("c1", 10 * MIN),
			newBreakTakenMessage("c1", 15, takenAt),
		];
		const first = breakPartsOf(msgs);
		const second = breakPartsOf(msgs);
		assert.deepEqual(second, first);
		assert.deepEqual(second[0]!.data, {
			toolCallId: "c1",
			state: "taken",
			takenAt,
			lengthMinutes: 15,
		});
	});

	// plan 002 part 6: offered -> taken -> ended follows the markers and carries breakMs
	it("follows offered -> taken -> ended across markers", () => {
		const takenAt = 11 * MIN;
		const breakMs = 9 * MIN + 42_000;
		const msgs = [
			...suggestBreakCall("c1", 10 * MIN),
			newBreakTakenMessage("c1", 10, takenAt),
			newBreakEndedMessage("c1", breakMs, "back", takenAt + breakMs),
		];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.deepEqual(parts[0]!.data, {
			toolCallId: "c1",
			state: "ended",
			takenAt,
			lengthMinutes: 10,
			breakMs,
		});
	});

	// plan 002 part 6: break-skipped moves data-break to skipped
	it("follows break-skipped to state skipped", () => {
		const msgs = [
			...suggestBreakCall("c1", 10 * MIN),
			newBreakSkippedMessage("c1", 11 * MIN),
		];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.deepEqual(parts[0]!.data, { toolCallId: "c1", state: "skipped" });
	});

	// plan 002 part 6: offered -> skipped by a later text message
	it("transitions offered to skipped when followed by a learner text message", () => {
		const msgs = [
			...suggestBreakCall("c1", 10 * MIN),
			userAt("u1", "keep going", 11 * MIN),
		];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.deepEqual(parts[0]!.data, { toolCallId: "c1", state: "skipped" });
	});

	// plan 002 part 6: a refused suggest_break call projects nothing
	it("emits nothing for a refused suggest_break call", () => {
		const okFalse = suggestBreakCall("c_false", 10 * MIN, false, false);
		const errored = suggestBreakCall("c_err", 10 * MIN, false, true);
		assert.deepEqual(projectView(okFalse), []);
		assert.deepEqual(projectView(errored), []);
	});

	// plan 002 part 6: the four break markers (break-note, break-taken, break-skipped, break-ended) render nothing
	it("renders nothing for the four break markers", () => {
		const msgs: LhMessage[] = [
			newBreakNoteMessage("window", "note", undefined, 1 * MIN),
			newBreakTakenMessage("c1", 10, 2 * MIN),
			newBreakSkippedMessage("c1", 3 * MIN),
			newBreakEndedMessage("c1", 5 * MIN, "back", 8 * MIN),
		];
		assert.deepEqual(projectView(msgs), []);
	});

	// plan 002 part 6: the view emits one data-break per ok call with each call's own state
	it("emits one data-break per ok call with independent states", () => {
		const msgs: LhMessage[] = [
			...suggestBreakCall("c1", 10 * MIN),
			newBreakSkippedMessage("c1", 11 * MIN),
			...suggestBreakCall("c2", 30 * MIN),
		];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 2);
		assert.equal(parts[0]!.id, "br_c1");
		assert.deepEqual(parts[0]!.data, { toolCallId: "c1", state: "skipped" });
		assert.equal(parts[1]!.id, "br_c2");
		assert.deepEqual(parts[1]!.data, { toolCallId: "c2", state: "offered" });
	});

	// plan 011 part 3: an ok suggest_break call with oneMoreQuestion true carries oneMoreQuestion on data-break
	it("carries oneMoreQuestion on data-break when suggest_break sets oneMoreQuestion true", () => {
		const msgs = [...suggestBreakCall("c1", 10 * MIN, true, false, true)];
		const parts = breakPartsOf(msgs);
		assert.equal(parts.length, 1);
		assert.equal(parts[0]!.id, "br_c1");
		assert.deepEqual(parts[0]!.data, { toolCallId: "c1", state: "offered", oneMoreQuestion: true });
	});
});
