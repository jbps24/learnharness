import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-category-route-"));
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

describe("exam category route", () => {
	// plan 010 part 1: PATCH with unknown path returns 404
	it("returns 404 for an unknown file path", async () => {
		const chat = chatStore.createChat("unknown path");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/known.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/missing.pdf", category: "exam" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 404);
	});

	// plan 010 part 1: PATCH with both binding and category in one body returns 400
	it("returns 400 when both binding and category are present or category is invalid", async () => {
		const chat = chatStore.createChat("both keys");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		for (const badBody of [
			{ path: "/course/a.pdf", binding: false, category: "exam" },
			{ path: "/course/a.pdf", category: "other" },
			{ path: "/course/a.pdf", category: 123 },
		]) {
			const res = await courseRoute.PATCH(patchRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
		}
	});

	// plan 010 part 1: PATCH with the same category as now returns 200 and changes nothing
	it("is a 200 no-op when category matches current effective category", async () => {
		const chat = chatStore.createChat("same category");
		const initial: CourseMaterial = {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
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
			methods: [{ nodeId: "n1", path: "/course/notes.pdf", method: "Route A" }],
			conflicts: [],
			examPatterns: [{ nodeId: "n1", path: "/course/ws22.pdf", source: "A1", pattern: "Solve" }],
		};
		chatStore.setCourseMaterial(chat.id, initial);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res1 = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/notes.pdf", category: "material" }),
				routeCtx(chat.id),
			);
			assert.equal(res1.status, 200);

			const res2 = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/ws22.pdf", category: "exam" }),
				routeCtx(chat.id),
			);
			assert.equal(res2.status, 200);

			assert.deepEqual(chatStore.getCourseMaterial(chat.id), initial);
			assert.deepEqual(events, []);
			assert.deepEqual(jobStore.listJobs(chat.id), []);
		} finally {
			off();
		}
	});

	// plan 010 part 1: PATCH moving a file sets category, categoryBy: "learner", status: "pending", removes methods/examPatterns/conflicts, saves, emits course-material-changed
	it("moves a material file to exam, resets fields, cleans methods/examPatterns/conflicts, saves, and emits", async () => {
		const chat = chatStore.createChat("move to exam");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/moved.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					categoryBy: "reader",
				},
				{
					path: "/course/other1.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/other2.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [
				{ nodeId: "n1", path: "/course/moved.pdf", method: "Old route" },
				{ nodeId: "n1", path: "/course/other1.pdf", method: "Kept route" },
			],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/moved.pdf", "/course/other1.pdf"] },
				{ nodeId: "n2", paths: ["/course/moved.pdf", "/course/other1.pdf", "/course/other2.pdf"] },
			],
			examPatterns: [
				{ nodeId: "n1", path: "/course/moved.pdf", source: "A1", pattern: "Stale pattern" },
				{ nodeId: "n2", path: "/course/other2.pdf", source: "A2", pattern: "Kept pattern" },
			],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/moved.pdf", category: "exam" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const updated = chatStore.getCourseMaterial(chat.id)!;
			assert.equal(updated.files[0]?.category, "exam");
			assert.equal(updated.files[0]?.categoryBy, "learner");
			assert.equal(updated.files[0]?.status, "pending");
			assert.deepEqual(updated.methods, [{ nodeId: "n1", path: "/course/other1.pdf", method: "Kept route" }]);
			assert.deepEqual(updated.examPatterns, [{ nodeId: "n2", path: "/course/other2.pdf", source: "A2", pattern: "Kept pattern" }]);
			assert.deepEqual(updated.conflicts, [{ nodeId: "n2", paths: ["/course/other1.pdf", "/course/other2.pdf"] }]);
		} finally {
			off();
		}
	});

	// plan 010 part 1: PATCH moving an exam file back to material also resets fields and cleans its entries
	it("moves an exam file back to material and cleans its examPatterns", async () => {
		const chat = chatStore.createChat("move to material");
		chatStore.setCourseMaterial(chat.id, {
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
			examPatterns: [{ nodeId: "n1", path: "/course/ws22.pdf", source: "WS22 A1", pattern: "Compute det" }],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/ws22.pdf", category: "material" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);

		const updated = chatStore.getCourseMaterial(chat.id)!;
		assert.equal(updated.files[0]?.category, "material");
		assert.equal(updated.files[0]?.categoryBy, "learner");
		assert.equal(updated.files[0]?.status, "pending");
		assert.deepEqual(updated.examPatterns, []);
	});

	// plan 010 part 1: PATCH moving a file hands the path to the assignment queue
	it("hands the moved file path to the assignment queue when the chat has a plan tree", async () => {
		const chat = chatStore.createChat("queued on move");
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "n1", title: "Eigenvalues", summary: "Characteristic polynomial" }],
			edges: [],
			version: 1,
		});
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/exam.pdf",
					addedAt: "2026-11-23T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/exam.pdf", category: "exam" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);

		await new Promise((resolve) => setTimeout(resolve, 25));
		const jobs = jobStore.listJobs(chat.id);
		assert.equal(
			jobs.some((job) => (job.input as { path?: string } | undefined)?.path === "/course/exam.pdf"),
			true,
		);
	});

	// plan 010 part 1: a body that is not a JSON object is a 400, not a 500
	it("returns 400 for a primitive, array or null body", async () => {
		const chat = chatStore.createChat("primitive body");
		for (const raw of ["123", "true", "\"str\"", "[]", "null"]) {
			const res = await courseRoute.PATCH(patchRequest(chat.id, raw), routeCtx(chat.id));
			assert.equal(res.status, 400, raw);
		}
	});

	// plan 010 part 1: a conflict that keeps two paths drops a `chosen` that pointed at the moved file
	it("clears conflict.chosen when the moved file was the chosen route", async () => {
		const chat = chatStore.createChat("chosen moved");
		const file = (p: string) => ({
			path: p,
			addedAt: "2026-11-23T10:00:00.000Z",
			via: "learner" as const,
			binding: true,
			status: "assigned" as const,
		});
		chatStore.setCourseMaterial(chat.id, {
			files: [file("/course/a.pdf"), file("/course/b.pdf"), file("/course/c.pdf")],
			methods: [],
			conflicts: [
				{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf", "/course/c.pdf"], chosen: "/course/a.pdf" },
				{ nodeId: "n2", paths: ["/course/a.pdf", "/course/b.pdf", "/course/c.pdf"], chosen: "/course/b.pdf" },
			],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/a.pdf", category: "exam" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);
		assert.deepEqual(chatStore.getCourseMaterial(chat.id)!.conflicts, [
			{ nodeId: "n1", paths: ["/course/b.pdf", "/course/c.pdf"] },
			{ nodeId: "n2", paths: ["/course/b.pdf", "/course/c.pdf"], chosen: "/course/b.pdf" },
		]);
	});
});
