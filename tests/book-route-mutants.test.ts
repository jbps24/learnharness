import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookRouteTargets } from "../src/core/book-routes.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { inheritCourseMaterial } from "../src/core/course-practice.ts";

const TIME = "2026-11-25T00:00:00.000Z";
const TREE: PlanTree = { nodes: [{ id: "n1", title: "Node 1" }], edges: [], version: 1 };

const slides = { path: "/course/slides.pdf", addedAt: TIME, via: "learner" as const, binding: true, status: "assigned" as const, category: "material" as const, materialKind: "overview" as const };
const book = { path: "/course/book.pdf", addedAt: TIME, via: "learner" as const, binding: true, status: "assigned" as const, category: "reference" as const };

function withRoute(pointerIds: string[], routeIds: string[]): CourseMaterial {
	return {
		files: [slides, book],
		methods: [{ nodeId: "n1", path: slides.path, method: "Overview" }],
		conflicts: [],
		referencePointers: [{ nodeId: "n1", path: book.path, sectionIds: pointerIds }],
		bookRoutes: [{ nodeId: "n1", path: book.path, sectionIds: routeIds, pages: "p. 1", method: "Derivation" }],
	};
}

describe("bookRouteTargets section id comparison", () => {
	// a route is stored only when every section id matches in order
	it("re-queues when only the later ids differ", () => {
		const result = bookRouteTargets(withRoute(["s1", "s2"], ["s1", "s3"]), TREE);
		assert.deepEqual(result.targets, [{ nodeId: "n1", path: book.path, sectionIds: ["s1", "s2"] }]);
		assert.deepEqual(result.material.bookRoutes ?? [], []);
	});

	it("re-queues when only the last id differs", () => {
		const result = bookRouteTargets(withRoute(["s1", "s2", "s3"], ["s1", "s2", "s4"]), TREE);
		assert.deepEqual(result.targets, [{ nodeId: "n1", path: book.path, sectionIds: ["s1", "s2", "s3"] }]);
	});
});

describe("inheritCourseMaterial book route dedup", () => {
	// the dedup key includes the method
	it("keeps two book routes on one path with different methods", () => {
		const lesson: ChatRecord = {
			id: "chat_1",
			title: "Lesson",
			createdAt: TIME,
			updatedAt: TIME,
			kind: "teach",
			messages: [
				{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "explain", arguments: { nodeId: "n1" } }], timestamp: 100 } as never,
			],
			tree: TREE,
			courseMaterial: {
				files: [slides, book],
				methods: [{ nodeId: "n1", path: slides.path, method: "Overview" }],
				conflicts: [],
				bookRoutes: [
					{ nodeId: "n1", path: book.path, sectionIds: ["s1"], pages: "p. 1", method: "First" },
					{ nodeId: "n1", path: book.path, sectionIds: ["s2"], pages: "p. 2", method: "Second" },
				],
			},
		};
		const inherited = inheritCourseMaterial(
			[{ id: "p1", name: "Prop", statement: "S", aliases: [], createdAt: TIME, provenance: [{ chatId: "chat_1", messageId: "m1" }] }],
			new Map([["chat_1", lesson]]),
		);
		const methods = inherited.propositionMethods.filter((m) => m.role === "book").map((m) => m.method);
		assert.deepEqual(methods, ["First", "Second"]);
	});
});
