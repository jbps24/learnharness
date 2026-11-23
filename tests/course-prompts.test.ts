import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const COURSE_MATERIAL_SECTION = [
	"## Course material",
	"",
	"Files the learner's course uses, listed in a [Course material] note, define how this learner has to solve problems. Their routes, steps and notation are binding: teach, check, hint and grade by them, never by a shorter or more standard route. A [Course method] note gives a node's binding route. If the learner asks for another route, give it and label it plainly as not from their course. Where the material leaves a step open, fill it from your own knowledge and say so.",
].join("\n");

const PLANNING_BULLET =
	"- If the session has course material, the route comes from it, not from you: read the course files before planning (pdf jobs for PDFs) and build the map along the material's own procedures, in its order and with its names. Your own knowledge checks the material and fills what it leaves open; it never replaces the material's route.";

const JOBS_SENTENCE =
	"Files the learner names become the lesson's course material; read them with that in mind.";

const PRACTICE_PARAGRAPH =
	"**Course methods.** When a [Course method] note lists a method for a proposition, model solutions, hints and verdicts follow that route and notation. A correct solution by another route is correct; name the route their course uses.";

describe("course-prompts", () => {
	// plan 007 part 5: shared 30-learner-files.md Course material section reaches the teacher agent
	it("includes the Course material section in the composed teacher prompt", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes(COURSE_MATERIAL_SECTION));
	});

	// plan 007 part 5: shared 30-learner-files.md Course material section reaches the prober agent
	it("includes the Course material section in the composed prober prompt", () => {
		const prompt = composeInstructions("prober");
		assert.ok(prompt.includes(COURSE_MATERIAL_SECTION));
	});

	// plan 007 part 5: shared 30-learner-files.md Course material section reaches the practice agent
	it("includes the Course material section in the composed practice prompt", () => {
		const prompt = composeInstructions("practice");
		assert.ok(prompt.includes(COURSE_MATERIAL_SECTION));
	});

	// plan 007 part 5: teacher/10-planning.md inserts the course-material planning bullet as the first bullet under Planning — think hard here
	it("inserts the course-material planning bullet first under Planning — think hard here in the teacher prompt", () => {
		const prompt = composeInstructions("teacher");
		const headingIndex = prompt.indexOf("## Planning — think hard here");
		const bulletIndex = prompt.indexOf(PLANNING_BULLET);
		const nextBulletIndex = prompt.indexOf("- Scope the field from your own knowledge:");
		assert.ok(headingIndex !== -1, "expected Planning — think hard here heading");
		assert.ok(bulletIndex !== -1, "expected course-material planning bullet");
		assert.ok(nextBulletIndex !== -1, "expected Scope the field bullet");
		assert.ok(headingIndex < bulletIndex && bulletIndex < nextBulletIndex);
	});

	// plan 007 part 5: teacher/40-jobs.md Learner source files includes the course material sentence
	it("includes the Learner source files course-material sentence in the teacher prompt", () => {
		const prompt = composeInstructions("teacher");
		const headingIndex = prompt.indexOf("## Learner source files");
		const sentenceIndex = prompt.indexOf(JOBS_SENTENCE);
		assert.ok(headingIndex !== -1, "expected Learner source files heading");
		assert.ok(sentenceIndex !== -1, "expected 40-jobs course material sentence");
		assert.ok(headingIndex < sentenceIndex);
	});

	// plan 007 part 5: practice/00-base.md appends the Course methods paragraph after The side tools.
	it("appends the Course methods paragraph after The side tools in the practice prompt", () => {
		const prompt = composeInstructions("practice");
		const sideToolsIndex = prompt.indexOf("**The side tools.**");
		const courseMethodsIndex = prompt.indexOf(PRACTICE_PARAGRAPH);
		assert.ok(sideToolsIndex !== -1, "expected The side tools. section");
		assert.ok(courseMethodsIndex !== -1, "expected Course methods paragraph");
		assert.ok(sideToolsIndex < courseMethodsIndex);
	});
});
