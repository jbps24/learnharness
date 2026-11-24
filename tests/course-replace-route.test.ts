import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-replace-route-"));
const REAL_TMP = fs.realpathSync.native(TMP_DATA);
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const replaceRoute = await import("../app/api/chats/[id]/course/replace/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function routeCtx(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

function postRequest(id: string, body: unknown): Request {
	return new Request(`http://localhost/api/chats/${id}/course/replace`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("course replace route", () => {
	// plan 015 part 2: 400 malformed (Expected { path: string, newPath: string })
	it("returns 400 for malformed bodies", async () => {
		const chat = chatStore.createChat("malformed replace");
		for (const badBody of [
			"not-json",
			[],
			{},
			{ path: "/course/a.md" },
			{ newPath: "/course/b.md" },
			{ path: 123, newPath: "/course/b.md" },
			{ path: "/course/a.md", newPath: 456 },
		]) {
			const res = await replaceRoute.POST(postRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
			assert.deepEqual(await res.json(), { error: "Expected { path: string, newPath: string }" });
		}
	});

	// plan 015 part 2: 404 unknown chat or path
	it("returns 404 when chat id or path is unknown", async () => {
		const missingChatRes = await replaceRoute.POST(
			postRequest("chat_missing", { path: "/course/a.md", newPath: "/course/b.md" }),
			routeCtx("chat_missing"),
		);
		assert.equal(missingChatRes.status, 404);

		const chat = chatStore.createChat("unknown path");
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: "/course/known.md", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});
		const missingPathRes = await replaceRoute.POST(
			postRequest(chat.id, { path: "/course/missing.md", newPath: "/course/b.md" }),
			routeCtx(chat.id),
		);
		assert.equal(missingPathRes.status, 404);
	});

	// plan 015 part 2: 400 Not a readable course file: <newPath> when missing, a directory, or not assignable
	it("returns 400 when newPath is missing, a directory, or not assignable", async () => {
		const chat = chatStore.createChat("bad newPath");
		const oldPath = path.join(REAL_TMP, "old.md");
		fs.writeFileSync(oldPath, "old", "utf8");
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: oldPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});

		const missingPath = path.join(REAL_TMP, "nope.md");
		const dirPath = path.join(REAL_TMP, "subdir");
		fs.mkdirSync(dirPath);
		const imagePath = path.join(REAL_TMP, "diagram.png");
		fs.writeFileSync(imagePath, "png", "utf8");

		for (const badNewPath of [missingPath, dirPath, imagePath]) {
			const res = await replaceRoute.POST(postRequest(chat.id, { path: oldPath, newPath: badNewPath }), routeCtx(chat.id));
			assert.equal(res.status, 400, badNewPath);
			assert.deepEqual(await res.json(), { error: `Not a readable course file: ${badNewPath}` });
		}
	});

	// plan 015 part 2: 409 <file name> is already in the list. when newPath != path and is listed
	it("returns 409 when newPath is a different file already in the list", async () => {
		const chat = chatStore.createChat("duplicate newPath");
		const fileA = path.join(REAL_TMP, "a.md");
		const fileB = path.join(REAL_TMP, "b.md");
		fs.writeFileSync(fileA, "A", "utf8");
		fs.writeFileSync(fileB, "B", "utf8");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{ path: fileA, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: fileB, addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
		});

		const res = await replaceRoute.POST(postRequest(chat.id, { path: fileA, newPath: fileB }), routeCtx(chat.id));
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: "b.md is already in the list." });
	});

	// plan 015 part 2: success takes snapshot, removes old path, clears old methods, emits, and returns 200 { ok: true }
	it("takes snapshot, removes old path, emits course-material-changed, and returns 200", async () => {
		const chat = chatStore.createChat("replace success");
		chatStore.saveTree(chat.id, {
			nodes: [
				{ id: "n1", title: "Node 1" },
				{ id: "n2", title: "Node 2" },
			],
			edges: [],
			version: 1,
		});
		const oldPath = path.join(REAL_TMP, "script-v1.md");
		const newPath = path.join(REAL_TMP, "script-v2.md");
		fs.writeFileSync(oldPath, "v1", "utf8");
		fs.writeFileSync(newPath, "v2", "utf8");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: oldPath,
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					changedOnDisk: true,
				},
			],
			methods: [{ nodeId: "n1", path: oldPath, pages: "p. 1", method: "Old method" }],
			conflicts: [],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await replaceRoute.POST(postRequest(chat.id, { path: oldPath, newPath }), routeCtx(chat.id));
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.ok(events.length >= 1);

			const material = chatStore.getCourseMaterial(chat.id) as CourseMaterial;
			assert.equal(material.files.some((f) => f.path === oldPath), false);
			const replaced = material.files.find((f) => f.path === newPath);
			assert.ok(replaced);
			assert.equal(Boolean(replaced.changedOnDisk), false);
			assert.equal(replaced.update?.fromPath, oldPath);
			assert.deepEqual(replaced.update?.previous, [{ nodeId: "n1", pages: "p. 1", method: "Old method" }]);
			assert.deepEqual(material.methods, []);
		} finally {
			off();
		}
	});

	// plan 015 part 2: newPath is resolved like resolveSourcePath (a symlink is stored as its real target)
	it("resolves a symlinked newPath to its real path", async () => {
		const chat = chatStore.createChat("symlink replace");
		const oldPath = path.join(REAL_TMP, "link-old.md");
		const target = path.join(REAL_TMP, "link-target.md");
		const link = path.join(REAL_TMP, "link-new.md");
		fs.writeFileSync(oldPath, "old", "utf8");
		fs.writeFileSync(target, "target", "utf8");
		fs.symlinkSync(target, link);
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: oldPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});

		const res = await replaceRoute.POST(postRequest(chat.id, { path: oldPath, newPath: link }), routeCtx(chat.id));
		assert.equal(res.status, 200);
		const material = chatStore.getCourseMaterial(chat.id) as CourseMaterial;
		assert.deepEqual(
			material.files.map((f) => f.path),
			[target],
		);
	});

	// plan 015 part 2: GET /course runs the change check; a file whose content changed on disk is flagged changedOnDisk
	it("GET /course flags a listed file whose content changed under the same name", async () => {
		const courseRoute = await import("../app/api/chats/[id]/course/route.ts");
		const { readFileFingerprint } = await import("../src/server/course-fingerprint.ts");
		const chat = chatStore.createChat("get change check");
		const filePath = path.join(REAL_TMP, "get-check.md");
		fs.writeFileSync(filePath, "version one", "utf8");
		const fingerprint = await readFileFingerprint(filePath);
		assert.ok(fingerprint);
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: filePath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint }],
			methods: [],
			conflicts: [],
		});
		fs.writeFileSync(filePath, "version two, longer", "utf8");

		const res = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { material: CourseMaterial };
		assert.equal(body.material.files[0]?.changedOnDisk, true);
	});

	// plan 015 part 2: same-path update succeeds when newPath === path
	it("supports same-path update when newPath equals path", async () => {
		const chat = chatStore.createChat("same path replace");
		const filePath = path.join(REAL_TMP, "notes.md");
		fs.writeFileSync(filePath, "updated content", "utf8");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: filePath,
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					changedOnDisk: true,
				},
			],
			methods: [{ nodeId: "n1", path: filePath, method: "Old route" }],
			conflicts: [],
		});

		const res = await replaceRoute.POST(postRequest(chat.id, { path: filePath, newPath: filePath }), routeCtx(chat.id));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });

		const material = chatStore.getCourseMaterial(chat.id) as CourseMaterial;
		const updated = material.files.find((f) => f.path === filePath);
		assert.ok(updated);
		assert.equal(Boolean(updated.changedOnDisk), false);
		assert.equal(updated.update?.fromPath, filePath);
		assert.deepEqual(updated.update?.previous, [{ nodeId: "n1", method: "Old route" }]);
	});
});
