import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-remove-route-"));
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

function deleteRequest(id: string, body: unknown): Request {
	return new Request(`http://localhost/api/chats/${id}/course`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("course route DELETE", () => {
	// plan 014 part 1: DELETE returns 400 with Expected { path: string } for a malformed body
	it("returns 400 for malformed bodies", async () => {
		const chat = chatStore.createChat("malformed delete");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});

		for (const badBody of ["not-json", null, [], {}, { path: 123 }, { path: null }]) {
			const res = await courseRoute.DELETE(deleteRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
			assert.deepEqual(await res.json(), { error: "Expected { path: string }" });
		}
	});

	// plan 014 part 1: DELETE returns 404 for an unknown chat or unknown path
	it("returns 404 for an unknown chat id or unknown course file path", async () => {
		const missingChatRes = await courseRoute.DELETE(
			deleteRequest("chat_missing", { path: "/course/a.pdf" }),
			routeCtx("chat_missing"),
		);
		assert.equal(missingChatRes.status, 404);

		const emptyChat = chatStore.createChat("no course material");
		const noMaterialRes = await courseRoute.DELETE(
			deleteRequest(emptyChat.id, { path: "/course/a.pdf" }),
			routeCtx(emptyChat.id),
		);
		assert.equal(noMaterialRes.status, 404);

		const chat = chatStore.createChat("unknown path");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/known.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		});
		const missingPathRes = await courseRoute.DELETE(
			deleteRequest(chat.id, { path: "/course/missing.pdf" }),
			routeCtx(chat.id),
		);
		assert.equal(missingPathRes.status, 404);
	});

	// plan 014 part 1: DELETE removes file and stored entries, saves, emits course-material-changed, and returns 200 { ok: true }
	it("removes the file, cleans up stored entries, emits course-material-changed, and returns 200 { ok: true }", async () => {
		const chat = chatStore.createChat("remove file");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/remove.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/keep.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "tutor", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/remove.pdf", method: "Removed" },
				{ nodeId: "n1", path: "/course/keep.pdf", method: "Kept" },
			],
			conflicts: [{ nodeId: "n1", paths: ["/course/remove.pdf", "/course/keep.pdf"], chosen: "/course/remove.pdf" }],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.DELETE(
				deleteRequest(chat.id, { path: "/course/remove.pdf" }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const getRes = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
			assert.equal(getRes.status, 200);
			const body = (await getRes.json()) as { material: CourseMaterial | null };
			assert.deepEqual(body.material, {
				files: [{ path: "/course/keep.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "tutor", binding: true, status: "assigned" }],
				methods: [{ nodeId: "n1", path: "/course/keep.pdf", method: "Kept" }],
				conflicts: [],
			});
		} finally {
			off();
		}
	});

	// plan 014 owner decision 1: removing the last file keeps courseMaterial defined as an empty object rather than null
	it("keeps courseMaterial defined with empty files when the last file is removed", async () => {
		const chat = chatStore.createChat("remove last");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: "/course/only.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.DELETE(
			deleteRequest(chat.id, { path: "/course/only.pdf" }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);

		const saved = chatStore.getChat(chat.id)?.courseMaterial;
		assert.deepEqual(saved, { files: [], methods: [], conflicts: [] });
	});
});
