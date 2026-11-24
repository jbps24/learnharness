import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reference-category-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
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
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("reference category route", () => {
	// plan 012 part 1: PATCH with the same category "reference" returns 200 and changes nothing
	it("is a 200 no-op when category is already reference", async () => {
		const chat = chatStore.createChat("same reference category");
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/textbook.pdf",
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
					path: "/course/textbook.pdf",
					from: "contents",
					sections: [{ id: "1.1", title: "1.1 Vectors", level: 2, startPage: 12, endPage: 18 }],
				},
			],
			referencePointers: [{ nodeId: "n1", path: "/course/textbook.pdf", sectionIds: ["1.1"] }],
		};
		chatStore.setCourseMaterial(chat.id, initial);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/textbook.pdf", category: "reference" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(chatStore.getCourseMaterial(chat.id), initial);
			assert.deepEqual(events, []);
			assert.deepEqual(jobStore.listJobs(chat.id), []);
		} finally {
			off();
		}
	});

	// plan 012 part 1: PATCH moving a file to "reference" resets fields, cleans methods/examPatterns/conflicts/referenceIndex/referencePointers, saves, and emits
	it("moves a file to reference, resets fields, cleans all per-file data, saves, and emits", async () => {
		const chat = chatStore.createChat("move to reference");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/moved.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "stale error",
					categoryBy: "reader",
				},
				{
					path: "/course/other1.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/other2.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/moved.pdf", method: "Old route" },
				{ nodeId: "n1", path: "/course/other1.pdf", method: "Kept route" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/moved.pdf", "/course/other1.pdf"] },
				{ nodeId: "n2", paths: ["/course/moved.pdf", "/course/other1.pdf", "/course/other2.pdf"], chosen: "/course/moved.pdf" },
			],
			examPatterns: [
				{ nodeId: "n1", path: "/course/moved.pdf", source: "A1", pattern: "Stale pattern" },
				{ nodeId: "n2", path: "/course/other1.pdf", source: "A2", pattern: "Kept pattern" },
			],
			referenceIndex: [
				{
					path: "/course/moved.pdf",
					from: "headings",
					sections: [{ id: "s0", title: "Intro", level: 1, startPage: 1, endPage: 5 }],
				},
				{
					path: "/course/other2.pdf",
					from: "outline",
					sections: [{ id: "1", title: "1 Basics", level: 1, startPage: 1, endPage: 10 }],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/moved.pdf", sectionIds: ["s0"] },
				{ nodeId: "n2", path: "/course/other2.pdf", sectionIds: ["1"] },
			],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/moved.pdf", category: "reference" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const updated = chatStore.getCourseMaterial(chat.id)!;
			assert.equal(updated.files[0]?.category, "reference");
			assert.equal(updated.files[0]?.categoryBy, "learner");
			assert.equal(updated.files[0]?.status, "pending");
			assert.equal("error" in updated.files[0]!, false);
			assert.deepEqual(updated.methods, [{ nodeId: "n1", path: "/course/other1.pdf", method: "Kept route" }]);
			assert.deepEqual(updated.examPatterns, [{ nodeId: "n2", path: "/course/other1.pdf", source: "A2", pattern: "Kept pattern" }]);
			assert.deepEqual(updated.conflicts, [{ nodeId: "n2", paths: ["/course/other1.pdf", "/course/other2.pdf"] }]);
			assert.deepEqual(updated.referenceIndex, [
				{
					path: "/course/other2.pdf",
					from: "outline",
					sections: [{ id: "1", title: "1 Basics", level: 1, startPage: 1, endPage: 10 }],
				},
			]);
			assert.deepEqual(updated.referencePointers, [{ nodeId: "n2", path: "/course/other2.pdf", sectionIds: ["1"] }]);
		} finally {
			off();
		}
	});

	// plan 012 part 1: PATCH moving a reference file out to material resets fields and removes its referenceIndex and referencePointers
	it("moves a reference file out to material and cleans its referenceIndex and referencePointers", async () => {
		const chat = chatStore.createChat("move from reference");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
					categoryBy: "reader",
				},
				{
					path: "/course/kept-book.pdf",
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
					path: "/course/book.pdf",
					from: "outline",
					sections: [{ id: "2.1", title: "2.1 Matrices", level: 2, startPage: 30, endPage: 40 }],
				},
				{
					path: "/course/kept-book.pdf",
					from: "outline",
					sections: [{ id: "3.1", title: "3.1 Spaces", level: 2, startPage: 50, endPage: 60 }],
				},
			],
			referencePointers: [
				{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["2.1"] },
				{ nodeId: "n2", path: "/course/kept-book.pdf", sectionIds: ["3.1"] },
			],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/book.pdf", category: "material" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const updated = chatStore.getCourseMaterial(chat.id)!;
			assert.equal(updated.files[0]?.category, "material");
			assert.equal(updated.files[0]?.categoryBy, "learner");
			assert.equal(updated.files[0]?.status, "pending");
			assert.deepEqual(updated.referenceIndex, [
				{
					path: "/course/kept-book.pdf",
					from: "outline",
					sections: [{ id: "3.1", title: "3.1 Spaces", level: 2, startPage: 50, endPage: 60 }],
				},
			]);
			assert.deepEqual(updated.referencePointers, [{ nodeId: "n2", path: "/course/kept-book.pdf", sectionIds: ["3.1"] }]);
		} finally {
			off();
		}
	});

	// plan 012 part 1: moving a file to reference works when referenceIndex and referencePointers are absent
	it("moves a file to reference when referenceIndex and referencePointers are absent", async () => {
		const chat = chatStore.createChat("move without reference fields");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/book.pdf", category: "reference" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);
		const updated = chatStore.getCourseMaterial(chat.id)!;
		assert.equal(updated.files[0]?.category, "reference");
		assert.equal(updated.files[0]?.status, "pending");
	});

	// plan 012 part 1: PATCH moving a file to or from reference hands the path to the assignment queue
	it("hands the moved file path to the assignment queue when moving to or from reference with a plan tree", async () => {
		const chat = chatStore.createChat("queued on reference move");
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "n1", title: "Eigenvalues", summary: "Characteristic polynomial" }],
			edges: [],
			version: 1,
		});
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/textbook.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-24T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
		});

		const resToRef = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/textbook.pdf", category: "reference" }),
			routeCtx(chat.id),
		);
		assert.equal(resToRef.status, 200);

		const resFromRef = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/notes.pdf", category: "material" }),
			routeCtx(chat.id),
		);
		assert.equal(resFromRef.status, 200);

		await new Promise((resolve) => setTimeout(resolve, 25));
		const jobs = jobStore.listJobs(chat.id);
		assert.equal(
			jobs.some((job) => (job.input as { path?: string } | undefined)?.path === "/course/textbook.pdf"),
			true,
		);
		assert.equal(
			jobs.some((job) => (job.input as { path?: string } | undefined)?.path === "/course/notes.pdf"),
			true,
		);
	});
});
