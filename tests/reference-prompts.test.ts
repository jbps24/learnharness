import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const REFERENCE_PARAGRAPH =
	"Files in a [Reference] note, usually the textbook behind the slides, are not course material. They never set what is learned: don't plan from them, add nodes for them, or teach their further topics unasked. Consult them when the learner asks something the course material doesn't answer, or when the material leaves a step, derivation or explanation open, before you fill it from your own knowledge, and whenever the learner asks: dispatch a pdf job on the pages the note points to and tell the learner you are checking the book. Where a reference uses another route or notation, the course material wins, except for the book routes in [Course method] notes; translate into the course material's notation. Cite the reference's pages.";

describe("reference-prompts", () => {
	// plan 012 part 4: shared 30-learner-files.md appends the confirmed Reference paragraph to Course material (teacher)
	it("appends the Reference paragraph to Course material in the composed teacher prompt", () => {
		const prompt = composeInstructions("teacher");
		const headingIndex = prompt.indexOf("## Course material");
		const refIndex = prompt.indexOf(REFERENCE_PARAGRAPH);
		assert.ok(headingIndex !== -1, "expected Course material heading");
		assert.ok(refIndex !== -1, "expected Reference paragraph");
		assert.ok(headingIndex < refIndex);
	});

	// plan 012 part 4: shared 30-learner-files.md Reference paragraph reaches the prober agent
	it("includes the Reference paragraph in the composed prober prompt", () => {
		const prompt = composeInstructions("prober");
		assert.ok(prompt.includes(REFERENCE_PARAGRAPH));
	});

	// plan 012 part 4: shared 30-learner-files.md Reference paragraph reaches the practice agent
	it("includes the Reference paragraph in the composed practice prompt", () => {
		const prompt = composeInstructions("practice");
		assert.ok(prompt.includes(REFERENCE_PARAGRAPH));
	});

	// plan 012 part 4: teacher/10-planning.md planning bullet changes "read the course files" to "read the course material files"
	it("updates the planning bullet to read the course material files instead of course files", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("read the course material files before planning"));
		assert.ok(!prompt.includes("read the course files before planning"));
	});
});
