import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

describe("prompt-breaks-doctrine", () => {
	// plan 002 part 7: composeInstructions("teacher") contains suggest_break
	it("teacher prompt contains suggest_break", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("suggest_break"), "expected teacher prompt to include suggest_break");
	});

	// plan 011 part 3: 45-breaks.md replaces the first two paragraphs with mid-node break doctrine and keeps the learner-is-back paragraph
	it("teacher prompt contains the mid-node break doctrine and keeps the learner-is-back paragraph", () => {
		const prompt = composeInstructions("teacher");
		const expectedFirst =
			"The app keeps time. When a [Session note] says a break is due, suggest it in that same turn: one line on the learner's input, then one line that this is a good moment for a break, call `suggest_break`, and end your turn. Mid-node is fine; don't wait for a node or unit end, and don't pose a new question first. Only when exactly one question would close the current node may you offer it first (`oneMoreQuestion` true). A question still open waits for its answer; the note rides that answer.";
		const expectedSecond =
			'Don\'t add advice on how to rest; the app shows that. If the learner asks for a break at any time, say yes in one line and call `suggest_break` with requestedBy "learner".';
		const expectedBack =
			"When a note says the learner is back, re-orient them in one line (where we are, what's next) and continue. Don't re-teach what was closed before the break.";
		assert.ok(prompt.includes("## Breaks"), "expected teacher prompt to include ## Breaks");
		assert.ok(prompt.includes(expectedFirst), "expected teacher prompt to include updated first paragraph");
		assert.ok(prompt.includes(expectedSecond), "expected teacher prompt to include updated second paragraph");
		assert.ok(prompt.includes(expectedBack), "expected teacher prompt to keep learner-is-back paragraph");
		assert.ok(!prompt.includes("closed point"), "expected teacher prompt not to include obsolete closed point doctrine");
	});

	// plan 002 part 7 / plan 011 part 3: prober prompt does not contain suggest_break or oneMoreQuestion
	it("prober prompt does not contain suggest_break or oneMoreQuestion", () => {
		const prompt = composeInstructions("prober");
		assert.ok(!prompt.includes("suggest_break"), "expected prober prompt not to include suggest_break");
		assert.ok(!prompt.includes("oneMoreQuestion"), "expected prober prompt not to include oneMoreQuestion");
	});

	// plan 002 part 7 / plan 011 part 3: practice prompt does not contain suggest_break or oneMoreQuestion
	it("practice prompt does not contain suggest_break or oneMoreQuestion", () => {
		const prompt = composeInstructions("practice");
		assert.ok(!prompt.includes("suggest_break"), "expected practice prompt not to include suggest_break");
		assert.ok(!prompt.includes("oneMoreQuestion"), "expected practice prompt not to include oneMoreQuestion");
	});
});
