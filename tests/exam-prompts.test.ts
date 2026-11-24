import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const EXAM_PATTERNS_PARAGRAPH =
	"**Exam patterns.** When an [Exam pattern] note covers a proposition, a problem on it takes the exam's shape by default: the same task type, givens, answer format and level, with new numbers. Name the model in the statement. The warm-up recall demands and the hint ladder stay as the doctrine says. The route still follows the [Course method] note.";

const NOT_AN_EXAM_ADDITION =
	"Where the learner's past exams set a task shape, you build within that shape; the strengthening choices (target, mode, difficulty step) stay yours.";

describe("exam-prompts", () => {
	// plan 010 part 3: practice/00-base.md adds the confirmed Exam patterns paragraph after Course methods
	it("includes the Exam patterns paragraph after Course methods in the composed practice prompt", () => {
		const prompt = composeInstructions("practice");
		const courseMethodsIndex = prompt.indexOf("**Course methods.**");
		const examPatternsIndex = prompt.indexOf(EXAM_PATTERNS_PARAGRAPH);
		assert.ok(courseMethodsIndex !== -1, "expected Course methods paragraph");
		assert.ok(examPatternsIndex !== -1, "expected Exam patterns paragraph");
		assert.ok(courseMethodsIndex < examPatternsIndex);
	});

	// plan 010 part 3: practice/10-doctrine.md section I Not an exam bullet gains the confirmed exam-shape sentence
	it("adds the exam-shape sentence to the Not an exam bullet in section I of the composed practice prompt", () => {
		const prompt = composeInstructions("practice");
		const notAnExamIndex = prompt.indexOf("- **Not an exam.**");
		const additionIndex = prompt.indexOf(NOT_AN_EXAM_ADDITION);
		const notTeachingIndex = prompt.indexOf("- **Not a teaching session.**");
		assert.ok(notAnExamIndex !== -1, "expected Not an exam bullet");
		assert.ok(additionIndex !== -1, "expected exam-shape addition");
		assert.ok(notTeachingIndex !== -1, "expected Not a teaching session bullet");
		assert.ok(notAnExamIndex < additionIndex && additionIndex < notTeachingIndex);
	});

	// plan 010 part 3: both exam prompt edits are absent from the teaching prompt
	it("omits both exam prompt edits from the composed teaching prompt", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(!prompt.includes(EXAM_PATTERNS_PARAGRAPH));
		assert.ok(!prompt.includes(NOT_AN_EXAM_ADDITION));
	});
});
