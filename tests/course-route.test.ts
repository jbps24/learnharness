import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-route-"));
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

describe("course route", () => {
	// plan 007 part 2: GET and PATCH return status 404 when the chat is unknown
	it("returns 404 when the chat id is unknown on GET or PATCH", async () => {
		const getRes = await courseRoute.GET(new Request("http://localhost/api/chats/chat_missing/course"), routeCtx("chat_missing"));
		assert.equal(getRes.status, 404);

		const patchRes = await courseRoute.PATCH(patchRequest("chat_missing", { path: "/course/a.pdf", binding: false }), routeCtx("chat_missing"));
		assert.equal(patchRes.status, 404);
	});

	// plan 007 part 2: GET returns { material: CourseMaterial | null, nodes: { id: string; title: string }[] }
	it("GET returns { material: null, nodes: [] } when neither courseMaterial nor tree exists", async () => {
		const chat = chatStore.createChat("empty course");
		const res = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { material: null, nodes: [] });
	});

	// plan 007 part 2: GET returns { material, nodes } with node titles taken from record.tree
	it("GET returns stored courseMaterial and node id/title pairs from record.tree", async () => {
		const chat = chatStore.createChat("with tree and material");
		chatStore.saveTree(chat.id, {
			nodes: [
				{ id: "n1", title: "Eigenvalues", summary: "Characteristic polynomial" },
				{ id: "n2", title: "Diagonalization" },
			],
			edges: [{ from: "n1", to: "n2" }],
			version: 1,
		});
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
				},
			],
			methods: [],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const res = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			material,
			nodes: [
				{ id: "n1", title: "Eigenvalues" },
				{ id: "n2", title: "Diagonalization" },
			],
		});
	});

	// plan 007 part 2: PATCH returns 400 for a malformed body
	it("PATCH returns 400 for malformed bodies", async () => {
		const chat = chatStore.createChat("malformed patch");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
				},
			],
			methods: [],
			conflicts: [],
		});

		for (const badBody of [
			"not-json",
			{},
			{ path: "/course/a.pdf" },
			{ binding: false },
			{ path: 123, binding: false },
			{ path: "/course/a.pdf", binding: "false" },
		]) {
			const res = await courseRoute.PATCH(patchRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
		}
	});

	// plan 007 part 2: PATCH with an unknown path returns 404
	it("PATCH with an unknown path returns 404", async () => {
		const chat = chatStore.createChat("unknown path");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/known.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/missing.pdf", binding: false }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 404);
	});

	// plan 007 part 2: PATCH false, then a GET, shows binding: false and emits course-material-changed
	it("PATCH false then GET shows binding: false and emits course-material-changed", async () => {
		const chat = chatStore.createChat("toggle off");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/lecture.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
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
			const patchRes = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/lecture.pdf", binding: false }),
				routeCtx(chat.id),
			);
			assert.equal(patchRes.status, 200);
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const getRes = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
			assert.equal(getRes.status, 200);
			const body = (await getRes.json()) as { material: CourseMaterial | null };
			assert.equal(body.material?.files[0]?.binding, false);
		} finally {
			off();
		}
	});

	// plan 007 part 2: PATCH only changes binding; re-ticking never sets status back to pending (choice 6)
	it("PATCH only changes binding and re-ticking never resets status to pending", async () => {
		const chat = chatStore.createChat("retick");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/assigned.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "tutor",
					binding: false,
					status: "assigned",
				},
				{
					path: "/course/failed.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: false,
					status: "failed",
					error: "read failed",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res1 = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/assigned.pdf", binding: true }),
			routeCtx(chat.id),
		);
		assert.equal(res1.status, 200);

		const res2 = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/failed.pdf", binding: true }),
			routeCtx(chat.id),
		);
		assert.equal(res2.status, 200);

		const material = chatStore.getCourseMaterial(chat.id);
		assert.equal(material?.files[0]?.binding, true);
		assert.equal(material?.files[0]?.status, "assigned");
		assert.equal(material?.files[1]?.binding, true);
		assert.equal(material?.files[1]?.status, "failed");
		assert.equal(material?.files[1]?.error, "read failed");
	});
});
