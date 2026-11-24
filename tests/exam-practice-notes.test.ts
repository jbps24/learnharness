import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newCompactionMarker } from "../src/core/compaction.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { practiceCourseNotesFor } from "../src/core/course-notes.ts";
import { failedResponseAtEnd } from "../src/core/input-events.ts";
import {
	nativeInputCause,
	newMessageId,
	newUserMessage,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

const PREAMBLE =
	"[Exam pattern] The learner's past exams ask about these propositions as follows. Pose problems on them in this shape (task type, givens, answer format, notation, level), with new numbers and functions, and name the model in the statement, e.g. \"in the style of WS22 A3b\". Where grading is given, model solutions and verdicts follow it.";

function failedAssistant(id = newMessageId()): LhMessage {
	return {
		id,
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
		timestamp: 10,
	} as never;
}

describe("exam-pattern marker and skip lists", () => {
	// plan 010 part 3: exam-pattern is neutral and in the same skip lists as course-method
	it("treats exam-pattern as neutral in nativeInputCause, toLlmMessages and failedResponseAtEnd", () => {
		const examPatternMsg: LhMarkerMessage = {
			id: newMessageId(),
			role: "custom",
			customType: "exam-pattern",
			content: "pattern text",
			display: false,
			details: { digest: "digest-1" },
			timestamp: 30,
		};

		assert.equal(nativeInputCause(examPatternMsg, []), "neutral");
		assert.deepEqual(toLlmMessages([examPatternMsg]), [
			{ role: "user", content: [{ type: "text", text: "pattern text" }], timestamp: examPatternMsg.timestamp },
		]);

		const user = newUserMessage("hi");
		const err = failedAssistant();
		assert.equal(failedResponseAtEnd([user, err, examPatternMsg])?.id, err.id);
	});
});

describe("practiceCourseNotesFor (exam-pattern)", () => {
	// plan 010 part 3: practiceCourseNotesFor emits no exam-pattern note without patterns
	it("returns no exam-pattern note when propositionExamPatterns is missing or empty", () => {
		assert.deepEqual(
			practiceCourseNotesFor([], { files: [], methods: [], conflicts: [], propositionMethods: [], propositionExamPatterns: [] }),
			[],
		);
	});

	// plan 010 part 3: practiceCourseNotesFor emits one exam-pattern note with the confirmed preamble and bullet format
	it("emits one exam-pattern note with the exact confirmed format with and without pages and grading", () => {
		const material: CourseMaterial = {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [],
			propositionExamPatterns: [
				{
					propositionId: "p1",
					lessonId: "lesson-1",
					nodeId: "nyquist-zones",
					path: "/course/ws22.pdf",
					source: "WS22 A3b",
					pages: "S. 4",
					pattern: "Sketch folding diagram for given f_s and f_0",
					grading: "1 pt axis, 2 pts folded frequency",
				},
				{
					propositionId: "p2",
					lessonId: "lesson-1",
					nodeId: "aliasing",
					path: "/course/ss23.md",
					source: "SS23 A1",
					pattern: "Compute minimum sampling rate",
				},
			],
		};

		const notes = practiceCourseNotesFor([], material);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.customType, "exam-pattern");
		assert.equal(notes[0]!.display, false);
		assert.equal(
			notes[0]!.content,
			[
				PREAMBLE,
				"- [p1] WS22 A3b (ws22.pdf, S. 4): Sketch folding diagram for given f_s and f_0 Grading: 1 pt axis, 2 pts folded frequency",
				"- [p2] SS23 A1 (ss23.md): Compute minimum sampling rate",
			].join("\n"),
		);
	});

	// plan 010 part 3: practiceCourseNotesFor applies the same digest rule to exam-pattern as to course-method
	it("emits exam-pattern once, suppresses while live, re-emits after compaction, and re-emits when digest changes", () => {
		const base: CourseMaterial = {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [],
			propositionExamPatterns: [
				{
					propositionId: "p1",
					lessonId: "lesson-1",
					nodeId: "n1",
					path: "/course/ws22.pdf",
					source: "WS22 A3b",
					pattern: "Original pattern",
				},
			],
		};

		const first = practiceCourseNotesFor([], base);
		assert.equal(first.length, 1);
		assert.equal(first[0]!.customType, "exam-pattern");
		const firstDigest = (first[0]!.details as { digest?: string } | null)?.digest;
		assert.ok(typeof firstDigest === "string" && firstDigest.length > 0);

		const kept = newUserMessage("next problem");
		assert.deepEqual(practiceCourseNotesFor([...first, kept], base), []);

		const compacted = [
			...first,
			newCompactionMarker("summary", {
				firstKeptMessageId: kept.id,
				tokensBefore: 1000,
				at: "2026-11-23T01:00:00.000Z",
			}),
			kept,
		];
		const afterCompaction = practiceCourseNotesFor(compacted, base);
		assert.equal(afterCompaction.length, 1);
		assert.equal(afterCompaction[0]!.customType, "exam-pattern");
		assert.equal(afterCompaction[0]!.content, first[0]!.content);

		const updated: CourseMaterial = {
			...base,
			propositionExamPatterns: [
				{
					propositionId: "p1",
					lessonId: "lesson-1",
					nodeId: "n1",
					path: "/course/ws22.pdf",
					source: "WS22 A3b",
					pattern: "Updated pattern",
				},
			],
		};
		const afterChange = practiceCourseNotesFor([...first, kept], updated);
		assert.equal(afterChange.length, 1);
		assert.equal(afterChange[0]!.customType, "exam-pattern");
		assert.notEqual((afterChange[0]!.details as { digest?: string } | null)?.digest, firstDigest);
	});
});
