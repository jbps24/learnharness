import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseFile, CourseMaterial } from "../src/core/contracts/course.ts";
import { BOOK_ROUTE_CAP, fileMaterialKind } from "../src/core/index.ts";
import { mergeCourseFiles } from "../src/core/course-files.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-material-kind-contracts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("material kind contracts", () => {
	// plan 020 part 1: fileMaterialKind(file) returns "complete" when absent, and otherwise returns the stored kind
	it("defaults fileMaterialKind to complete when absent and returns explicit values", () => {
		const base: CourseFile = {
			path: "/course/slides.pdf",
			addedAt: "2026-11-25T10:00:00.000Z",
			via: "learner",
			binding: true,
			status: "assigned",
		};

		assert.equal(fileMaterialKind(base), "complete");
		assert.equal(fileMaterialKind({ ...base, materialKind: "complete" }), "complete");
		assert.equal(fileMaterialKind({ ...base, materialKind: "overview" }), "overview");
	});

	// plan 020 part 1: BOOK_ROUTE_CAP is exported from core
	it("exports BOOK_ROUTE_CAP from src/core/index.ts", () => {
		assert.equal(typeof BOOK_ROUTE_CAP, "number");
	});

	// plan 020 part 1: a record without the new fields round-trips unchanged through chatStore
	it("round-trips a CourseMaterial record without the new fields unchanged", () => {
		const chat = chatStore.createChat("legacy material");
		const legacy: CourseMaterial = {
			files: [
				{
					path: "/course/legacy.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/legacy.pdf", method: "Gaussian elimination" }],
			conflicts: [],
		};

		chatStore.setCourseMaterial(chat.id, legacy);
		const loaded = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(loaded, legacy);
		assert.equal("materialKind" in (loaded?.files[0] ?? {}), false);
		assert.equal("materialKindBy" in (loaded?.files[0] ?? {}), false);
		assert.equal("bookRoutes" in (loaded ?? {}), false);
	});

	// plan 020 part 1: chatStore persists materialKind, materialKindBy, and bookRoutes
	it("round-trips a CourseMaterial record with materialKind, materialKindBy, and bookRoutes", () => {
		const chat = chatStore.createChat("with book routes");
		const routeEntry = { nodeId: "n1", path: "/ref/book.pdf" } as unknown as NonNullable<CourseMaterial["bookRoutes"]>[number];
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
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
			bookRoutes: [routeEntry],
		};

		chatStore.setCourseMaterial(chat.id, material);
		assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);
	});

	// plan 020 part 1: material merge keeps the new fields
	it("mergeCourseFiles keeps materialKind, materialKindBy, and bookRoutes on existing material", () => {
		const routeEntry = { nodeId: "n1", path: "/ref/book.pdf" } as unknown as NonNullable<CourseMaterial["bookRoutes"]>[number];
		const existing: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					materialKind: "overview",
					materialKindBy: "learner",
				},
			],
			methods: [],
			conflicts: [],
			bookRoutes: [routeEntry],
		};

		const merged = mergeCourseFiles(
			existing,
			[{ path: "/course/extra.pdf", via: "tutor" }],
			"2026-11-25T11:00:00.000Z",
		);

		assert.deepEqual(merged.added, ["/course/extra.pdf"]);
		assert.equal(merged.material.files[0]?.materialKind, "overview");
		assert.equal(merged.material.files[0]?.materialKindBy, "learner");
		assert.deepEqual(merged.material.bookRoutes, [routeEntry]);
	});
});
