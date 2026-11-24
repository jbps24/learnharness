import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	ASSIGNABLE_EXTENSIONS,
	COURSE_METHOD_CAP,
	type CourseMaterial,
} from "../src/core/contracts/course.ts";
import { courseFilesUsed, isAssignable, mergeCourseFiles } from "../src/core/course-files.ts";
import {
	newAnswerResult,
	newMessageId,
	newThinkingMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

function assistantToolCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
		})),
		timestamp: 1,
	} as never;
}

function sideQuestionMarker(customType: "side-question" | "side-question-told", text: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType,
		content: text,
		display: false,
		details: null,
		timestamp: 1,
	};
}

describe("isAssignable", () => {
	// plan 007 part 1: ASSIGNABLE_EXTENSIONS are .pdf, .md, .markdown, .txt, .tex (case-insensitive) and COURSE_METHOD_CAP is 1_500
	it("recognizes all assignable extensions case-insensitively and rejects others", () => {
		assert.equal(COURSE_METHOD_CAP, 1_500);
		assert.deepEqual(ASSIGNABLE_EXTENSIONS, [".pdf", ".md", ".markdown", ".txt", ".tex"]);
		for (const ext of [".pdf", ".PDF", ".md", ".Md", ".markdown", ".txt", ".tex", ".TEX"]) {
			assert.equal(isAssignable(`/course/notes${ext}`), true, ext);
		}
		for (const path of ["/course/diagram.png", "/course/photo.jpg", "/course/code.ts", "/course/README"]) {
			assert.equal(isAssignable(path), false, path);
		}
	});
});

describe("courseFilesUsed", () => {
	// plan 007 part 1: empty transcript returns empty list
	it("returns an empty list for an empty transcript", () => {
		assert.deepEqual(courseFilesUsed([]), []);
	});

	// plan 007 part 1: learner message with two chipped paths and a directory reference gives the two files with via: 'learner'
	it("collects chipped paths from learner text messages and skips directory references", () => {
		const messages: LhMessage[] = [
			newUserMessage("Please use `/course/lecture1.pdf` and `/course/slides.md`, ignore `/course/folder/`"),
			{
				id: newMessageId(),
				role: "user",
				content: [{ type: "text", text: "Also `/course/extra.tex`" }],
				timestamp: 2,
			},
		];
		assert.deepEqual(courseFilesUsed(messages), [
			{ path: "/course/lecture1.pdf", via: "learner" },
			{ path: "/course/slides.md", via: "learner" },
			{ path: "/course/extra.tex", via: "learner" },
		]);
	});

	// plan 007 part 1: learner practice-thinking contents are scanned for chipped paths
	it("collects paths from practice-thinking marker contents", () => {
		const messages: LhMessage[] = [
			newThinkingMessage("prob_1", "Using `/course/formulae.pdf` here"),
		];
		assert.deepEqual(courseFilesUsed(messages), [
			{ path: "/course/formulae.pdf", via: "learner" },
		]);
	});

	// plan 007 part 1: path in an answered explain's readingThinking (and text) is found
	it("collects paths from answered explain and quiz readingThinking and text", () => {
		const messages: LhMessage[] = [
			newAnswerResult("call_1", "explain", {
				kind: "explain",
				questionText: "Explain stability",
				dontKnow: false,
				answers: [],
				text: "From `/course/notes.md`",
				readingThinking: "Checked `/course/regelung.pdf`",
				answeredAt: "2026-11-22T00:00:00.000Z",
			}),
			newAnswerResult("call_2", "quiz", {
				kind: "quiz",
				questionText: "Which pole?",
				dontKnow: false,
				answers: [],
				readingThinking: "See `/course/quiz-ref.txt`",
				answeredAt: "2026-11-22T00:00:00.000Z",
			}),
		];
		assert.deepEqual(courseFilesUsed(messages), [
			{ path: "/course/notes.md", via: "learner" },
			{ path: "/course/regelung.pdf", via: "learner" },
			{ path: "/course/quiz-ref.txt", via: "learner" },
		]);
	});

	// plan 007 part 1: read, pdf, and visual pdf.path tool calls give via: 'tutor', and first occurrence wins via
	it("collects read, pdf, and visual pdf.path tool calls with via: 'tutor' and preserves first-occurrence via", () => {
		const messages: LhMessage[] = [
			newUserMessage("I attached `/course/shared.pdf`"),
			assistantToolCalls([
				{ id: "c1", name: "read", arguments: { path: "/course/shared.pdf" } },
				{ id: "c2", name: "read", arguments: { path: "/course/notes.md" } },
				{ id: "c3", name: "pdf", arguments: { path: "/course/slides.pdf", question: "Summarize" } },
				{ id: "c4", name: "visual", arguments: { brief: "Plot", pdf: { path: "/course/fig.pdf", page: 3 } } },
			]),
			newUserMessage("Later mentioning `/course/fig.pdf`"),
		];
		assert.deepEqual(courseFilesUsed(messages), [
			{ path: "/course/shared.pdf", via: "learner" },
			{ path: "/course/notes.md", via: "tutor" },
			{ path: "/course/slides.pdf", via: "tutor" },
			{ path: "/course/fig.pdf", via: "tutor" },
		]);
	});

	// plan 007 part 1: paths are absolute and home-resolved; `~/x` and the expanded absolute path are one file
	it("expands ~/ to the home directory and dedupes against the absolute path", () => {
		const home = os.homedir();
		const messages: LhMessage[] = [
			newUserMessage("Use `~/course/a.pdf`"),
			assistantToolCalls([
				{ id: "c1", name: "read", arguments: { path: "~/course/b.md" } },
				{ id: "c2", name: "read", arguments: { path: path.join(home, "course", "a.pdf") } },
			]),
		];
		assert.deepEqual(courseFilesUsed(messages), [
			{ path: path.join(home, "course", "a.pdf"), via: "learner" },
			{ path: path.join(home, "course", "b.md"), via: "tutor" },
		]);
	});

	// plan 007 part 1: paths that are not absolute after ~ expansion are ignored
	it("ignores ~user paths that stay non-absolute after expansion", () => {
		const messages: LhMessage[] = [
			assistantToolCalls([{ id: "c1", name: "read", arguments: { path: "~other/notes.pdf" } }]),
		];
		assert.deepEqual(courseFilesUsed(messages), []);
	});

	// plan 007 part 1: never collects URLs, relative paths, or side-chat messages
	it("ignores URLs, relative paths, and side-chat messages", () => {
		const messages: LhMessage[] = [
			newUserMessage("Ignore `https://example.com/a.pdf`, `file:///course/b.pdf`, `notes.pdf`, `./sub/c.md`, `../d.txt`"),
			assistantToolCalls([
				{ id: "c1", name: "read", arguments: { path: "relative/e.md" } },
				{ id: "c2", name: "pdf", arguments: { path: "https://example.com/f.pdf", question: "Q" } },
			]),
			sideQuestionMarker("side-question", "Question about `/course/side1.pdf`"),
			sideQuestionMarker("side-question-told", "Told about `/course/side2.pdf`"),
		];
		assert.deepEqual(courseFilesUsed(messages), []);
	});
});

describe("mergeCourseFiles", () => {
	const NOW = "2026-11-22T12:00:00.000Z";

	// plan 007 part 1: undefined existing with empty found initializes empty CourseMaterial
	it("initializes empty CourseMaterial when existing is undefined and found is empty", () => {
		assert.deepEqual(mergeCourseFiles(undefined, [], NOW), {
			material: { files: [], methods: [], conflicts: [] },
			added: [],
		});
	});

	// plan 007 part 1: unknown paths are added with binding: true, status pending or not-assignable, and returned in added
	it("adds unknown files with binding: true and pending or not-assignable status", () => {
		const result = mergeCourseFiles(
			undefined,
			[
				{ path: "/course/a.PDF", via: "learner" },
				{ path: "/course/diagram.png", via: "tutor" },
			],
			NOW,
		);
		assert.deepEqual(result.added, ["/course/a.PDF", "/course/diagram.png"]);
		assert.deepEqual(result.material, {
			files: [
				{
					path: "/course/a.PDF",
					addedAt: NOW,
					via: "learner",
					binding: true,
					status: "pending",
				},
				{
					path: "/course/diagram.png",
					addedAt: NOW,
					via: "tutor",
					binding: true,
					status: "not-assignable",
				},
			],
			methods: [],
			conflicts: [],
		});
	});

	// plan 007 part 1: merge never removes files and never changes an existing file's binding, status, or via
	it("preserves unticked binding, failed status, existing via, unmentioned files, and existing methods/conflicts", () => {
		const existing: CourseMaterial = {
			files: [
				{
					path: "/course/unticked.pdf",
					addedAt: "2026-11-20T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
				},
				{
					path: "/course/broken.pdf",
					addedAt: "2026-11-20T00:00:00.000Z",
					via: "tutor",
					binding: true,
					status: "failed",
					error: "parse error",
				},
				{
					path: "/course/old.md",
					addedAt: "2026-11-20T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/old.md", method: "M" }],
			conflicts: [{ nodeId: "n2", paths: ["/course/old.md", "/course/unticked.pdf"] }],
		};

		const result = mergeCourseFiles(
			existing,
			[
				{ path: "/course/unticked.pdf", via: "tutor" },
				{ path: "/course/broken.pdf", via: "learner" },
				{ path: "/course/new.tex", via: "tutor" },
			],
			NOW,
		);

		assert.deepEqual(result.added, ["/course/new.tex"]);
		assert.deepEqual(result.material.methods, existing.methods);
		assert.deepEqual(result.material.conflicts, existing.conflicts);
		assert.deepEqual(result.material.files, [
			existing.files[0],
			existing.files[1],
			existing.files[2],
			{
				path: "/course/new.tex",
				addedAt: NOW,
				via: "tutor",
				binding: true,
				status: "pending",
			},
		]);
	});
});
