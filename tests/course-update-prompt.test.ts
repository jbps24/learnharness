import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const REFERENCE_PARAGRAPH =
	"Files in a [Reference] note, usually the textbook behind the slides, are not course material. They never set what is learned: don't plan from them, add nodes for them, or teach their further topics unasked. Consult them when the learner asks something the course material doesn't answer, or when the material leaves a step, derivation or explanation open, before you fill it from your own knowledge, and whenever the learner asks: dispatch a pdf job on the pages the note points to and tell the learner you are checking the book. Where a reference uses another route or notation, the course material wins; translate into its notation. Cite the reference's pages.";

const COURSE_UPDATE_PARAGRAPH =
	"A [Course update] note means the learner's course published a newer version of a file. Follow the new routes from now on. Treat its items as part of the teaching, not as an interruption: point out a changed route where it fits the conversation, and ask the plan question at a natural pause.";

describe("course-update-prompt", () => {
	// plan 015 part 3: shared 30-learner-files.md includes confirmed course update paragraph after Reference paragraph
	it("includes the course update paragraph after the Reference paragraph in the teacher prompt", () => {
		const prompt = composeInstructions("teacher");
		const refIndex = prompt.indexOf(REFERENCE_PARAGRAPH);
		const updateIndex = prompt.indexOf(COURSE_UPDATE_PARAGRAPH);
		assert.ok(refIndex !== -1, "expected Reference paragraph");
		assert.ok(updateIndex !== -1, "expected Course update paragraph");
		assert.ok(refIndex < updateIndex);
	});
});
