import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	EXAM_PATTERN_CAP,
	fileCategory,
	type CourseFile,
	type CourseMaterial,
	type ExamPattern,
} from "../src/core/index.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-contracts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("exam contracts", () => {
	// plan 010 part 1: EXAM_PATTERN_CAP is 1_200
	it("exports EXAM_PATTERN_CAP as 1_200", () => {
		assert.equal(EXAM_PATTERN_CAP, 1_200);
	});

	// plan 010 part 1: fileCategory returns "material" when category is absent, otherwise file.category
	it("fileCategory defaults to material when absent and returns the explicit category otherwise", () => {
		const base: CourseFile = {
			path: "/course/notes.pdf",
			addedAt: "2026-11-23T10:00:00.000Z",
			via: "learner",
			binding: true,
			status: "assigned",
		};
		assert.equal(fileCategory(base), "material");
		assert.equal(fileCategory({ ...base, category: "material" }), "material");
		assert.equal(fileCategory({ ...base, category: "exam" }), "exam");
	});

	// plan 010 part 1: a record without category round-trips unchanged through chatStore
	it("round-trips a record without category unchanged", () => {
		const chat = chatStore.createChat("legacy course");
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/lecture.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/lecture.pdf", method: "Gaussian elimination" }],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const loaded = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(loaded, material);
		assert.equal("category" in loaded!.files[0]!, false);
		assert.equal("categoryBy" in loaded!.files[0]!, false);
		assert.equal("examPatterns" in loaded!, false);
		assert.equal(fileCategory(loaded!.files[0]!), "material");
	});

	// plan 010 part 1: CourseMaterial gains examPatterns and propositionExamPatterns
	it("round-trips examPatterns and propositionExamPatterns on CourseMaterial", () => {
		const chat = chatStore.createChat("exam patterns");
		const pattern: ExamPattern = {
			nodeId: "n1",
			path: "/course/ws22.pdf",
			source: "WS22 A3b",
			pages: "S. 4",
			pattern: "Compute eigenvalues of a 3x3 matrix with parameter k.",
			grading: "1 pt characteristic polynomial, 2 pts roots",
		};
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/ws22.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			examPatterns: [pattern],
			propositionExamPatterns: [
				{
					...pattern,
					propositionId: "prop_1",
					lessonId: "lesson_1",
				},
			],
		};
		chatStore.setCourseMaterial(chat.id, material);

		assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);
	});
});
