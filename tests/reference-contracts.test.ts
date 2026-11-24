import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	REFERENCE_SECTIONS_CAP,
	fileCategory,
	type CourseFile,
	type CourseMaterial,
	type ReferenceSection,
} from "../src/core/index.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reference-contracts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("reference contracts", () => {
	// plan 012 part 1: REFERENCE_SECTIONS_CAP is 800
	it("exports REFERENCE_SECTIONS_CAP as 800", () => {
		assert.equal(REFERENCE_SECTIONS_CAP, 800);
	});

	// plan 012 part 1: fileCategory returns "material" when absent and returns file.category including "reference"
	it("fileCategory defaults to material when absent and returns reference when set", () => {
		const base: CourseFile = {
			path: "/course/book.pdf",
			addedAt: "2026-11-24T10:00:00.000Z",
			via: "learner",
			binding: true,
			status: "assigned",
		};
		assert.equal(fileCategory(base), "material");
		assert.equal(fileCategory({ ...base, category: "material" }), "material");
		assert.equal(fileCategory({ ...base, category: "exam" }), "exam");
		assert.equal(fileCategory({ ...base, category: "reference" }), "reference");
	});

	// plan 012 part 1: a record without the new reference fields round-trips unchanged
	it("round-trips a record without reference fields unchanged", () => {
		const chat = chatStore.createChat("legacy material");
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Row reduction" }],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const loaded = chatStore.getCourseMaterial(chat.id);
		assert.deepEqual(loaded, material);
		assert.equal("category" in loaded!.files[0]!, false);
		assert.equal("referenceIndex" in loaded!, false);
		assert.equal("referencePointers" in loaded!, false);
		assert.equal(fileCategory(loaded!.files[0]!), "material");
	});

	// plan 012 part 1: CourseMaterial gains referenceIndex (with ReferenceSection) and referencePointers
	it("round-trips referenceIndex and referencePointers on CourseMaterial", () => {
		const chat = chatStore.createChat("reference material");
		const sections: ReferenceSection[] = [
			{
				id: "6.2",
				title: "6.2 Eigenvalues and Eigenvectors",
				level: 2,
				startPage: 201,
				endPage: 206,
				label: "pp. 187–192",
			},
			{
				id: "s1",
				title: "Appendix A",
				level: 1,
				startPage: 410,
				endPage: 420,
			},
		];
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/strang.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
					categoryBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
			referenceIndex: [
				{
					path: "/course/strang.pdf",
					from: "outline",
					sections,
				},
			],
			referencePointers: [
				{
					nodeId: "n1",
					path: "/course/strang.pdf",
					sectionIds: ["6.2"],
				},
			],
		};
		chatStore.setCourseMaterial(chat.id, material);

		assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);
	});
});
