import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

describe("prompt-breaks-doctrine", () => {
	// plan 002 part 7: composeInstructions("teacher") contains suggest_break
	it("teacher prompt contains suggest_break", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("suggest_break"), "expected teacher prompt to include suggest_break");
	});

	// plan 002 part 7: composeInstructions("teacher") contains closed point
	it("teacher prompt contains closed point", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("closed point"), "expected teacher prompt to include closed point");
	});

	// plan 002 part 7: teacher break doctrine includes ## Breaks, [Session note], and requestedBy "learner"
	it("teacher prompt contains break doctrine details", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("## Breaks"), "expected teacher prompt to include ## Breaks");
		assert.ok(prompt.includes("[Session note]"), "expected teacher prompt to include [Session note]");
		assert.ok(prompt.includes('requestedBy "learner"'), 'expected teacher prompt to include requestedBy "learner"');
	});

	// plan 002 part 7: prober prompt does not contain suggest_break or closed point
	it("prober prompt does not contain suggest_break or closed point", () => {
		const prompt = composeInstructions("prober");
		assert.ok(!prompt.includes("suggest_break"), "expected prober prompt not to include suggest_break");
		assert.ok(!prompt.includes("closed point"), "expected prober prompt not to include closed point");
	});

	// plan 002 part 7: practice prompt does not contain suggest_break or closed point
	it("practice prompt does not contain suggest_break or closed point", () => {
		const prompt = composeInstructions("practice");
		assert.ok(!prompt.includes("suggest_break"), "expected practice prompt not to include suggest_break");
		assert.ok(!prompt.includes("closed point"), "expected practice prompt not to include closed point");
	});
});
