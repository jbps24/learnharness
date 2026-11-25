import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-material-kind-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
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

const EXPECTED_400_ERROR =
	'Expected { path: string, binding: boolean }, { path: string, category: "material" | "exam" | "reference" }, { path: string, materialKind: "complete" | "overview" } or { path: string, retry: true }';

describe("course route materialKind PATCH", () => {
	// plan 020 part 1: PATCH { path, materialKind } sets materialKind and materialKindBy: "learner", does not re-read, and emits course-material-changed
	it("sets materialKind and materialKindBy: learner without re-reading and emits course-material-changed", async () => {
		const chat = chatStore.createChat("set materialKind");
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/slides.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
					materialKind: "complete",
					materialKindBy: "reader",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/slides.pdf", method: "Slide method" }],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/slides.pdf", materialKind: "overview" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const updated = chatStore.getCourseMaterial(chat.id);
			assert.equal(updated?.files[0]?.materialKind, "overview");
			assert.equal(updated?.files[0]?.materialKindBy, "learner");
			assert.equal(updated?.files[0]?.status, "assigned");
			assert.deepEqual(updated?.methods, material.methods);
		} finally {
			off();
		}
	});

	// plan 020 part 1: PATCH { path, materialKind: "complete" } flips an overview file back to complete with materialKindBy: "learner"
	it("switches overview back to complete with materialKindBy: learner", async () => {
		const chat = chatStore.createChat("switch to complete");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					materialKind: "overview",
					materialKindBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/notes.pdf", materialKind: "complete" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });

		const updated = chatStore.getCourseMaterial(chat.id);
		assert.equal(updated?.files[0]?.materialKind, "complete");
		assert.equal(updated?.files[0]?.materialKindBy, "learner");
	});

	// plan 020 part 1: PATCH { path, materialKind } with the same effective kind is a { ok: true } no-op
	it("is a no-op when materialKind already matches (including absent -> complete)", async () => {
		const chat = chatStore.createChat("noop materialKind");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/absent.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
				{
					path: "/course/overview.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					materialKind: "overview",
					materialKindBy: "reader",
				},
			],
			methods: [],
			conflicts: [],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res1 = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/absent.pdf", materialKind: "complete" }),
				routeCtx(chat.id),
			);
			assert.equal(res1.status, 200);
			assert.deepEqual(await res1.json(), { ok: true });

			const res2 = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/overview.pdf", materialKind: "overview" }),
				routeCtx(chat.id),
			);
			assert.equal(res2.status, 200);
			assert.deepEqual(await res2.json(), { ok: true });
			assert.deepEqual(events, []);

			const updated = chatStore.getCourseMaterial(chat.id);
			assert.equal("materialKind" in (updated?.files[0] ?? {}), false);
			assert.equal("materialKindBy" in (updated?.files[0] ?? {}), false);
			assert.equal(updated?.files[1]?.materialKindBy, "reader");
		} finally {
			off();
		}
	});

	// plan 020 part 1: PATCH materialKind on a file whose category is not material returns 400
	it("returns 400 when target file category is exam or reference", async () => {
		const chat = chatStore.createChat("non-material category");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/exam.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "exam",
				},
				{
					path: "/course/book.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "reference",
				},
			],
			methods: [],
			conflicts: [],
		});

		for (const filePath of ["/course/exam.pdf", "/course/book.pdf"]) {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: filePath, materialKind: "overview" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 400, filePath);
		}

		const stored = chatStore.getCourseMaterial(chat.id);
		assert.equal("materialKind" in (stored?.files[0] ?? {}), false);
		assert.equal("materialKind" in (stored?.files[1] ?? {}), false);
	});

	// plan 020 part 1: invalid materialKind or more than one of binding, category, retry, materialKind returns 400 with the extended error text
	it("returns 400 with extended error text on invalid materialKind or combined bodies", async () => {
		const chat = chatStore.createChat("bad materialKind bodies");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-25T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		});

		for (const badBody of [
			{ path: "/course/a.pdf", materialKind: "slides" },
			{ path: "/course/a.pdf", materialKind: 123 },
			{ path: "/course/a.pdf", materialKind: "overview", binding: false },
			{ path: "/course/a.pdf", materialKind: "overview", category: "material" },
			{ path: "/course/a.pdf", materialKind: "overview", retry: true },
		]) {
			const res = await courseRoute.PATCH(patchRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
			assert.deepEqual(await res.json(), { error: EXPECTED_400_ERROR });
		}
	});
});
