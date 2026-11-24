import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakTimings, ESCALATION_NOTE_TEXT, windowNoteText } from "../src/core/breaks.ts";

describe("break-texts", () => {
	// plan 011 part 3: exact windowNoteText for interval 45
	it("formats windowNoteText for interval 45", () => {
		const timings = breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 });
		assert.equal(
			windowNoteText(timings),
			'[Session note] The learner has been learning for about 45 minutes. In this turn, respond to their input in one line, then suggest a short break instead of going on: say so in one line, call suggest_break with requestedBy "window" and end your turn. Mid-node is fine. If exactly one question remains until the current node is closed, you may instead offer it first: say in one line that one question would close the node and ask whether they want to answer it before the break, then call suggest_break with requestedBy "window" and oneMoreQuestion true.',
		);
	});

	// plan 011 part 3: exact windowNoteText for interval 60
	it("formats windowNoteText for interval 60", () => {
		const timings = breakTimings({ intervalMinutes: 60, lengthMinutes: 10, resetMinutes: 15 });
		assert.equal(
			windowNoteText(timings),
			'[Session note] The learner has been learning for about 60 minutes. In this turn, respond to their input in one line, then suggest a short break instead of going on: say so in one line, call suggest_break with requestedBy "window" and end your turn. Mid-node is fine. If exactly one question remains until the current node is closed, you may instead offer it first: say in one line that one question would close the node and ask whether they want to answer it before the break, then call suggest_break with requestedBy "window" and oneMoreQuestion true.',
		);
	});

	// plan 011 part 3: exact ESCALATION_NOTE_TEXT
	it("exposes the exact ESCALATION_NOTE_TEXT", () => {
		assert.equal(
			ESCALATION_NOTE_TEXT,
			"[Session note] A break is overdue. In this turn, respond to the learner's input in one line, then suggest the break.",
		);
	});
});
