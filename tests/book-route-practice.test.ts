import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import { inheritCourseMaterial } from "../src/core/course-practice.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function makeTeachMessage(id: string, nodeId: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${id}`,
				name: "explain",
				arguments: { nodeId },
			},
		],
		timestamp: 100,
	} as never;
}

function makeLesson(id: string, courseMaterial: CourseMaterial): ChatRecord {
	return {
		id,
		title: "Lesson",
		createdAt: "2026-11-25T00:00:00.000Z",
		updatedAt: "2026-11-25T00:00:00.000Z",
		kind: "teach",
		messages: [makeTeachMessage("m1", "n1")],
		tree: {
			nodes: [{ id: "n1", title: "Node 1" }],
			edges: [],
			version: 1,
		},
		courseMaterial,
	};
}

function makePick(id: string, provenance: Array<{ chatId: string; messageId: string }>): GraphNode {
	return {
		id,
		name: "Prop",
		statement: "Statement",
		aliases: [],
		createdAt: "2026-11-25T00:00:00.000Z",
		provenance,
	};
}

describe("inheritCourseMaterial book routes", () => {
	// plan 020 part 4: inheritCourseMaterial copies binding non-failed book routes with role: "book", path, pages, method
	it("copies binding non-failed book routes as PropositionMethod entries with role: 'book'", () => {
		const lesson = makeLesson("chat_1", {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" },
			],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10-12", method: "Book derivation" },
			],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "chat_1", messageId: "m1" }])],
			new Map([["chat_1", lesson]]),
		);

		const bookEntry = inherited.propositionMethods.find((m) => m.role === "book");
		assert.deepEqual(bookEntry, {
			propositionId: "p1",
			lessonId: "chat_1",
			nodeId: "n1",
			role: "book",
			path: "/course/book.pdf",
			pages: "pp. 10-12",
			method: "Book derivation",
		});
		const materialEntry = inherited.propositionMethods.find((m) => m.role !== "book");
		assert.deepEqual(materialEntry, {
			propositionId: "p1",
			lessonId: "chat_1",
			nodeId: "n1",
			path: "/course/slides.pdf",
			pages: "S. 4",
			method: "Slide route",
		});
	});

	// plan 020 part 4: only binding non-failed book routes are copied by inheritCourseMaterial
	it("skips failed book routes and book routes from non-binding reference files", () => {
		const lesson = makeLesson("chat_1", {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book-bound.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
				{
					path: "/course/book-unbound.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: false,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" }],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book-bound.pdf", sectionIds: ["s1"], pages: "", method: "", error: "Failed to read" },
				{ nodeId: "n1", path: "/course/book-unbound.pdf", sectionIds: ["s1"], pages: "pp. 1-2", method: "Unbound book route" },
			],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "chat_1", messageId: "m1" }])],
			new Map([["chat_1", lesson]]),
		);

		assert.deepEqual(inherited.propositionMethods.filter((m) => m.role === "book"), []);
	});

	// plan 020 part 4: inheritCourseMaterial deduplicates book routes per proposition
	it("deduplicates identical book routes across multiple provenance points for the same proposition", () => {
		const lesson = makeLesson("chat_1", {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" }],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10-12", method: "Book derivation" },
			],
		});
		lesson.messages = [makeTeachMessage("m1", "n1"), makeTeachMessage("m2", "n1")];

		const inherited = inheritCourseMaterial(
			[
				makePick("p1", [
					{ chatId: "chat_1", messageId: "m1" },
					{ chatId: "chat_1", messageId: "m2" },
				]),
			],
			new Map([["chat_1", lesson]]),
		);

		assert.equal(inherited.propositionMethods.filter((m) => m.role === "book").length, 1);
	});

	const bookFile = {
		path: "/course/book.pdf",
		addedAt: "2026-11-25T00:00:00.000Z",
		via: "learner" as const,
		binding: true,
		status: "assigned" as const,
		category: "reference" as const,
	};
	const slideFile = {
		path: "/course/slides.pdf",
		addedAt: "2026-11-25T00:00:00.000Z",
		via: "learner" as const,
		binding: true,
		status: "assigned" as const,
		category: "material" as const,
		materialKind: "overview" as const,
	};
	const scriptFile = { ...slideFile, path: "/course/script.pdf", materialKind: "complete" as const };

	function bookCountFor(files: CourseMaterial["files"], methods: CourseMaterial["methods"]): number {
		const lesson = makeLesson("chat_1", {
			files,
			methods,
			conflicts: [],
			bookRoutes: [{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 1-2", method: "Book derivation" }],
		});
		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "chat_1", messageId: "m1" }])],
			new Map([["chat_1", lesson]]),
		);
		return inherited.propositionMethods.filter((m) => m.role === "book").length;
	}

	// plan 020 part 4: a node with a binding Complete route gets no book route
	it("copies no book route for a node with a binding Complete route", () => {
		assert.equal(
			bookCountFor([scriptFile, bookFile], [
				{ nodeId: "n1", path: "/course/script.pdf", pages: "S. 1", method: "Script route" },
			]),
			0,
		);
	});

	// plan 020 part 4: a node with any Complete route (mixed with Overview) gets no book route
	it("copies no book route for a node with mixed Overview and Complete routes", () => {
		assert.equal(
			bookCountFor([slideFile, scriptFile, bookFile], [
				{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" },
				{ nodeId: "n1", path: "/course/script.pdf", pages: "S. 1", method: "Script route" },
			]),
			0,
		);
	});

	// plan 020 part 4: a node the slides don't cover gets no book route
	it("copies no book route for a node without any binding material route", () => {
		assert.equal(bookCountFor([bookFile], []), 0);
	});

	it("skips book routes with an error despite non-empty method or with an empty method without error", () => {
		const lesson = makeLesson("chat_1", {
			files: [slideFile, bookFile],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", pages: "S. 4", method: "Slide route" }],
			conflicts: [],
			bookRoutes: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "p. 1", method: "Partial", error: "Failed" },
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s2"], pages: "", method: "" },
			],
		});

		const inherited = inheritCourseMaterial(
			[makePick("p1", [{ chatId: "chat_1", messageId: "m1" }])],
			new Map([["chat_1", lesson]]),
		);

		assert.deepEqual(inherited.propositionMethods.filter((m) => m.role === "book"), []);
	});
});
