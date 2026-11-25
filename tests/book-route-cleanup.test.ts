import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import { removeCourseFile } from "../src/core/course-remove.ts";
import { startReplacement } from "../src/core/course-replace.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-route-cleanup-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const courseRoute = await import("../app/api/chats/[id]/course/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function routeCtx(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

function patchRequest(id: string, body: unknown): Request {
	return new Request(`http://localhost/api/chats/${id}/course`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

type BookRouteEntry = NonNullable<CourseMaterial["bookRoutes"]>[number];

function makeBookRoute(nodeId: string, filePath: string): BookRouteEntry {
	return { nodeId, path: filePath } as unknown as BookRouteEntry;
}

describe("book route and materialKind cleanup", () => {
	// plan 020 part 1: removing a file (plan 014) removes bookRoutes whose path is that file
	it("removeCourseFile removes bookRoutes for the removed path and leaves others untouched", () => {
		const keptRoute = makeBookRoute("n1", "/ref/keep.pdf");
		const material: CourseMaterial = {
			files: [
				{ path: "/ref/remove.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				{ path: "/ref/keep.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
			bookRoutes: [
				makeBookRoute("n1", "/ref/remove.pdf"),
				keptRoute,
			],
		};

		const result = removeCourseFile(material, "/ref/remove.pdf");
		assert.deepEqual(result.bookRoutes, [keptRoute]);

		const withoutBookRoutes: CourseMaterial = {
			files: [
				{ path: "/ref/remove.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
		};
		const emptyResult = removeCourseFile(withoutBookRoutes, "/ref/remove.pdf");
		assert.equal("bookRoutes" in emptyResult, false);
	});

	// plan 020 part 1: moving a file out of reference (PATCH category) removes its bookRoutes
	it("PATCH category moving a file out of reference removes its bookRoutes", async () => {
		const chat = chatStore.createChat("move out of reference");
		const keptRoute = makeBookRoute("n1", "/ref/other.pdf");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/ref/book.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				{ path: "/ref/other.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
			bookRoutes: [
				makeBookRoute("n1", "/ref/book.pdf"),
				keptRoute,
			],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/ref/book.pdf", category: "material" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);

		const updated = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(updated?.bookRoutes, [keptRoute]);
	});

	// plan 020 part 1: moving a file out of material (PATCH category) clears its materialKind and materialKindBy
	it("PATCH category moving a file out of material clears materialKind and materialKindBy", async () => {
		const chat = chatStore.createChat("move out of material");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
					materialKindBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/slides.pdf", category: "reference" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);

		const updated = chatStore.getCourseMaterial(chat.id);
		assert.equal(updated?.files[0]?.category, "reference");
		assert.equal("materialKind" in (updated?.files[0] ?? {}), false);
		assert.equal("materialKindBy" in (updated?.files[0] ?? {}), false);
	});

	// plan 020 part 1: replacing a reference file (plan 015) removes its bookRoutes
	it("startReplacement on a reference file removes its bookRoutes and leaves others untouched", () => {
		const keptRoute = makeBookRoute("n1", "/ref/other.pdf");
		const material: CourseMaterial = {
			files: [
				{ path: "/ref/old-book.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				{ path: "/ref/other.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
			],
			methods: [],
			conflicts: [],
			bookRoutes: [
				makeBookRoute("n1", "/ref/old-book.pdf"),
				keptRoute,
			],
		};

		const result = startReplacement(material, "/ref/old-book.pdf", "/ref/new-book.pdf", "2026-11-25T12:00:00.000Z");
		assert.deepEqual(result.bookRoutes, [keptRoute]);
	});

	// plan 020 part 1: replacing a material file keeps its materialKind only when materialKindBy === "learner"
	it("startReplacement keeps materialKind only when materialKindBy is learner", () => {
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/learner-set.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
					materialKindBy: "learner",
				},
				{
					path: "/course/reader-set.pdf",
					addedAt: "2026-11-25T10:01:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "overview",
					materialKindBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
		};

		const afterLearner = startReplacement(material, "/course/learner-set.pdf", "/course/learner-set-v2.pdf", "2026-11-25T12:00:00.000Z");
		assert.equal(afterLearner.files[0]?.materialKind, "overview");
		assert.equal(afterLearner.files[0]?.materialKindBy, "learner");

		const afterReader = startReplacement(material, "/course/reader-set.pdf", "/course/reader-set-v2.pdf", "2026-11-25T12:00:00.000Z");
		assert.equal("materialKind" in (afterReader.files[1] ?? {}), false);
		assert.equal("materialKindBy" in (afterReader.files[1] ?? {}), false);
	});
});
