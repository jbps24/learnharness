import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newCompactionMarker } from "../src/core/compaction.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { practiceCourseNotesFor } from "../src/core/course-notes.ts";
import { newUserMessage } from "../src/core/native-messages.ts";

describe("practiceCourseNotesFor", () => {
	// plan 007 part 6: with no material (or no binding files and no proposition methods), there are no notes
	it("returns no notes when material is undefined or has no binding files or proposition methods", () => {
		assert.deepEqual(practiceCourseNotesFor([], undefined), []);
		assert.deepEqual(
			practiceCourseNotesFor([], { files: [], methods: [], conflicts: [], propositionMethods: [] }),
			[],
		);
	});

	// plan 007 part 6: emits course-files and one course-method note listing every proposition method
	it("emits course-files and one course-method note with the exact confirmed format", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/notes.md", addedAt: "2026-11-22T00:00:00.000Z", via: "inherited", binding: true, status: "assigned" },
				{ path: "/course/signals.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "inherited", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{
					propositionId: "p1",
					lessonId: "lesson-1",
					nodeId: "nyquist-zones",
					path: "/course/signals.pdf",
					pages: "S. 12–15",
					method: "Use folding diagram",
				},
				{
					propositionId: "p2",
					lessonId: "lesson-1",
					nodeId: "aliasing",
					path: "/course/notes.md",
					method: "Check Nyquist rate",
				},
			],
		};

		const notes = practiceCourseNotesFor([], material);
		assert.equal(notes.length, 2);

		assert.equal(notes[0]!.customType, "course-files");
		assert.deepEqual(notes[0]!.details, { paths: ["/course/notes.md", "/course/signals.pdf"] });

		assert.equal(notes[1]!.customType, "course-method");
		assert.equal(
			notes[1]!.content,
			[
				"[Course method] The learner's course solves these propositions as follows. Model solutions, hints and verdicts follow exactly these routes:",
				"- [p1] (from node `nyquist-zones`): Use folding diagram (signals.pdf, S. 12–15)",
				"- [p2] (from node `aliasing`): Check Nyquist rate (notes.md)",
			].join("\n"),
		);
	});

	// plan 007 part 6: the practice note is due once and again after compaction
	it("emits the practice notes once, suppresses them while live, and re-emits them after compaction", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/signals.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "inherited", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{
					propositionId: "p1",
					lessonId: "lesson-1",
					nodeId: "nyquist-zones",
					path: "/course/signals.pdf",
					pages: "S. 12–15",
					method: "Use folding diagram",
				},
			],
		};

		const first = practiceCourseNotesFor([], material);
		assert.equal(first.length, 2);

		const kept = newUserMessage("next problem");
		assert.deepEqual(practiceCourseNotesFor([...first, kept], material), []);

		const compacted = [
			...first,
			newCompactionMarker("summary", {
				firstKeptMessageId: kept.id,
				tokensBefore: 1000,
				at: "2026-11-22T01:00:00.000Z",
			}),
			kept,
		];
		const afterCompaction = practiceCourseNotesFor(compacted, material);
		assert.equal(afterCompaction.length, 2);
		assert.equal(afterCompaction[0]!.customType, "course-files");
		assert.equal(afterCompaction[1]!.customType, "course-method");
		assert.equal(afterCompaction[1]!.content, first[1]!.content);
	});

	// plan 007 part 6: a course-files note follows the teaching rule, so it is due again when the binding set changes
	it("re-emits course-files when the binding set changes while a prior note is live", () => {
		const base = { methods: [], conflicts: [], propositionMethods: [] };
		const file = (path: string, binding = true) => ({
			path,
			addedAt: "2026-11-22T00:00:00.000Z",
			via: "tutor" as const,
			binding,
			status: "pending" as const,
		});
		const before: CourseMaterial = { ...base, files: [file("/course/a.pdf")] };
		const first = practiceCourseNotesFor([], before);
		assert.equal(first.length, 1);

		const added: CourseMaterial = { ...base, files: [file("/course/a.pdf"), file("/course/b.pdf")] };
		const afterAdd = practiceCourseNotesFor([...first], added);
		assert.equal(afterAdd.length, 1);
		assert.equal(afterAdd[0]!.customType, "course-files");
		assert.deepEqual(afterAdd[0]!.details, { paths: ["/course/a.pdf", "/course/b.pdf"] });

		const unticked: CourseMaterial = { ...base, files: [file("/course/a.pdf", false), file("/course/b.pdf")] };
		const afterUntick = practiceCourseNotesFor([...first, ...afterAdd], unticked);
		assert.equal(afterUntick.length, 1);
		assert.deepEqual(afterUntick[0]!.details, { paths: ["/course/b.pdf"] });
	});

	// plan 007 part 6: files the practice session reads itself join and are listed, and unticked files are excluded
	it("lists practice-read binding files in course-files and excludes unticked files", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/self-read.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "tutor", binding: true, status: "pending" },
				{ path: "/course/unticked.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "inherited", binding: false, status: "assigned" },
			],
			methods: [],
			conflicts: [],
			propositionMethods: [],
		};

		const notes = practiceCourseNotesFor([], material);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.customType, "course-files");
		assert.deepEqual(notes[0]!.details, { paths: ["/course/self-read.pdf"] });
	});
});
