import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	nativeInputCause,
	newBreakEndedMessage,
	newBreakNoteMessage,
	newBreakSkippedMessage,
	newBreakTakenMessage,
	newUserMessage,
	reconstructRequestCause,
	toLlmMessages,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { failedResponseAtEnd } from "../src/core/input-events.ts";

const failedAssistant = (id: string, timestamp: number): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		stopReason: "error",
		errorMessage: "boom",
		timestamp,
	}) as never;

describe("break markers", () => {
	// plan 002 part 2: newBreakNoteMessage(kind, text, windowId?) has display: false and details: { kind, windowId } where a fresh window note's windowId is its own id
	it("newBreakNoteMessage window sets display false and defaults windowId to its own id", () => {
		const note = newBreakNoteMessage("window", "[Session note] take a break", undefined, 1000);
		assert.equal(note.role, "custom");
		assert.equal(note.customType, "break-note");
		assert.equal(note.display, false);
		assert.equal(note.content, "[Session note] take a break");
		assert.equal(note.timestamp, 1000);
		assert.deepEqual(note.details, { kind: "window", windowId: note.id });
	});

	// plan 002 part 2: newBreakNoteMessage accepts explicit windowId and optional now timestamp
	it("newBreakNoteMessage escalation and away preserve explicit windowId and optional now", () => {
		const esc = newBreakNoteMessage("escalation", "overdue", "win_1", 2000);
		assert.equal(esc.customType, "break-note");
		assert.equal(esc.display, false);
		assert.equal(esc.timestamp, 2000);
		assert.deepEqual(esc.details, { kind: "escalation", windowId: "win_1" });

		const away = newBreakNoteMessage("away", "back", undefined, 3000);
		assert.equal(away.customType, "break-note");
		assert.equal(away.display, false);
		assert.equal(away.timestamp, 3000);
		assert.deepEqual(away.details, { kind: "away", windowId: undefined });
	});

	// plan 002 part 2: constructors for break-taken, break-skipped, break-ended take optional now
	it("newBreakTakenMessage, newBreakSkippedMessage, and newBreakEndedMessage set customType, content, and timestamp", () => {
		const taken = newBreakTakenMessage("call_1", 10, 4000);
		assert.equal(taken.role, "custom");
		assert.equal(taken.customType, "break-taken");
		assert.equal(taken.timestamp, 4000);

		const skipped = newBreakSkippedMessage("call_1", 5000);
		assert.equal(skipped.role, "custom");
		assert.equal(skipped.customType, "break-skipped");
		assert.equal(skipped.timestamp, 5000);

		const ended = newBreakEndedMessage("call_1", 600_000, "[Session note] back from break", 6000);
		assert.equal(ended.role, "custom");
		assert.equal(ended.customType, "break-ended");
		assert.equal(ended.content, "[Session note] back from break");
		assert.equal(ended.timestamp, 6000);
	});

	// plan 002 part 2: nativeInputCause maps break-taken, break-skipped, break-ended -> learner; break-note -> neutral
	it("nativeInputCause classifies break-taken, break-skipped, break-ended as learner and break-note as neutral", () => {
		assert.equal(nativeInputCause(newBreakTakenMessage("c1", 10, 100), []), "learner");
		assert.equal(nativeInputCause(newBreakSkippedMessage("c1", 200), []), "learner");
		assert.equal(nativeInputCause(newBreakEndedMessage("c1", 5000, "back", 300), []), "learner");
		assert.equal(nativeInputCause(newBreakNoteMessage("window", "note", undefined, 400), []), "neutral");
	});

	// plan 002 part 2: toLlmMessages sends break-note and break-ended as user text and filters break-taken and break-skipped
	it("toLlmMessages carries break-note and break-ended as user text and drops break-taken and break-skipped", () => {
		const msgs: LhMessage[] = [
			newBreakNoteMessage("window", "window note text", undefined, 100),
			newBreakTakenMessage("c1", 10, 200),
			newBreakSkippedMessage("c2", 300),
			newBreakEndedMessage("c1", 60_000, "break ended text", 400),
		];
		const wire = toLlmMessages(msgs);
		assert.equal(wire.length, 2);
		assert.equal(wire[0]?.role, "user");
		assert.deepEqual(wire[0]?.content, [{ type: "text", text: "window note text" }]);
		assert.equal(wire[1]?.role, "user");
		assert.deepEqual(wire[1]?.content, [{ type: "text", text: "break ended text" }]);
	});

	// plan 002 part 2: reconstructRequestCause of a transcript ending in break-ended is foreground
	it("reconstructRequestCause of a transcript ending in break-ended is foreground", () => {
		const user = { ...newUserMessage("hi"), timestamp: 100 };
		const ended = newBreakEndedMessage("c1", 60_000, "back", 200);
		assert.equal(reconstructRequestCause([user, ended]), "foreground");
	});

	// plan 002 part 2: break-note is in the neutral list, so a trailing break-note does not change the reconstructed cause
	it("reconstructRequestCause skips a trailing break-note as neutral", () => {
		const steer = {
			id: "s1",
			role: "custom",
			customType: "subagent-steer",
			content: "steer",
			display: false,
			details: null,
			timestamp: 100,
		} as LhMessage;
		const note = newBreakNoteMessage("window", "note", undefined, 200);
		assert.equal(reconstructRequestCause([steer, note]), "background");
	});

	// plan 002 part 2: input-events.ts skip list includes break-note
	it("failedResponseAtEnd skips break-note markers", () => {
		const err = failedAssistant("a_err", 100);
		const note = newBreakNoteMessage("away", "away note", undefined, 200);
		assert.equal(failedResponseAtEnd([err, note])?.id, "a_err");
	});
});
