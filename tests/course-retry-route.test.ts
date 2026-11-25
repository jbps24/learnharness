import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseFileStatus, CourseMaterial } from "../src/core/contracts/course.ts";
import type { ServerEvent } from "../src/core/events.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-retry-route-"));
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

const EXPECTED_400_MESSAGE =
	'Expected { path: string, binding: boolean }, { path: string, category: "material" | "exam" | "reference" }, { path: string, materialKind: "complete" | "overview" } or { path: string, retry: true }';

describe("course retry route", () => {
	// plan 013 part 1: retry of a failed ticked file sets status to pending, removes error, keeps other fields and stored data unchanged, emits course-material-changed, and returns 200 { ok: true }
	it("retries a failed ticked file, removes error, preserves all other fields and stored data, and emits course-material-changed", async () => {
		const chat = chatStore.createChat("retry failed");
		const initialMaterial: CourseMaterial = {
			files: [
				{
					path: "/course/failed.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "read timed out",
					category: "exam",
					categoryBy: "learner",
				},
				{
					path: "/course/other.pdf",
					addedAt: "2026-11-22T09:00:00.000Z",
					via: "tutor",
					binding: true,
					status: "assigned",
					category: "material",
				},
			],
			methods: [{ nodeId: "n1", path: "/course/other.pdf", pages: "p. 1-4", method: "existing method" }],
			conflicts: [{ nodeId: "n1", paths: ["/course/other.pdf", "/course/third.pdf"], chosen: "/course/other.pdf" }],
			examPatterns: [{ nodeId: "n1", path: "/course/failed.pdf", source: "WS22 A1", pattern: "sketch" }],
			referenceIndex: [{ path: "/course/ref.pdf", from: "headings", sections: [{ id: "s1", title: "Intro", level: 1, startPage: 1, endPage: 2 }] }],
			referencePointers: [{ nodeId: "n1", path: "/course/ref.pdf", sectionIds: ["s1"] }],
		};
		chatStore.setCourseMaterial(chat.id, initialMaterial);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/failed.pdf", retry: true }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true });
			assert.deepEqual(events, [{ type: "course-material-changed", chatId: chat.id }]);

			const updated = chatStore.getCourseMaterial(chat.id);
			assert.ok(updated);
			const retriedFile = updated.files.find((f) => f.path === "/course/failed.pdf");
			assert.ok(retriedFile);
			assert.equal(retriedFile.status, "pending");
			assert.equal("error" in retriedFile, false);
			assert.deepEqual(retriedFile, {
				path: "/course/failed.pdf",
				addedAt: "2026-11-22T10:00:00.000Z",
				via: "learner",
				binding: true,
				status: "pending",
				category: "exam",
				categoryBy: "learner",
			});
			assert.deepEqual(updated.files[1], initialMaterial.files[1]);
			assert.deepEqual(updated.methods, initialMaterial.methods);
			assert.deepEqual(updated.conflicts, initialMaterial.conflicts);
			assert.deepEqual(updated.examPatterns, initialMaterial.examPatterns);
			assert.deepEqual(updated.referenceIndex, initialMaterial.referenceIndex);
			assert.deepEqual(updated.referencePointers, initialMaterial.referencePointers);
		} finally {
			off();
		}
	});

	// plan 013 part 1: retry calls assignAddedCourseFiles(id, [path]) to queue the file again
	it("queues the retried file via assignAddedCourseFiles when a plan tree exists", async () => {
		const chat = chatStore.createChat("retry queues");
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "n1", title: "Eigenvalues" }],
			edges: [],
			version: 1,
		});
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/retry-queue.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "previous failure",
				},
			],
			methods: [],
			conflicts: [],
		});

		const res = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/retry-queue.pdf", retry: true }),
			routeCtx(chat.id),
		);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });

		for (let i = 0; i < 50; i++) {
			const jobs = jobStore.listJobs(chat.id);
			if (jobs.some((j) => j.toolCallId.startsWith("course-assign:") && (j.input as { path?: string })?.path === "/course/retry-queue.pdf")) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const queued = jobStore
			.listJobs(chat.id)
			.find((j) => j.toolCallId.startsWith("course-assign:") && (j.input as { path?: string })?.path === "/course/retry-queue.pdf");
		assert.ok(queued, "expected a course-assign job to be queued for the retried file");
	});

	// plan 013 part 1: file status not failed returns 409 { error: "Only a failed course file can be retried." }
	it("returns 409 for each non-failed file status", async () => {
		const nonFailedStatuses: Exclude<CourseFileStatus, "failed">[] = [
			"pending",
			"assigning",
			"assigned",
			"not-assignable",
		];

		for (const status of nonFailedStatuses) {
			const chat = chatStore.createChat(`non-failed-${status}`);
			const filePath = `/course/${status}.pdf`;
			const material: CourseMaterial = {
				files: [
					{
						path: filePath,
						addedAt: "2026-11-22T10:00:00.000Z",
						via: "learner",
						binding: true,
						status,
					},
				],
				methods: [],
				conflicts: [],
			};
			chatStore.setCourseMaterial(chat.id, material);

			const events: ServerEvent[] = [];
			const off = subscribe((e) => {
				if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
			});
			try {
				const res = await courseRoute.PATCH(
					patchRequest(chat.id, { path: filePath, retry: true }),
					routeCtx(chat.id),
				);
				assert.equal(res.status, 409, status);
				assert.deepEqual(await res.json(), { error: "Only a failed course file can be retried." });
				assert.deepEqual(events, []);
				assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);
			} finally {
				off();
			}
		}
	});

	// plan 013 part 1: unticked file returns 409 { error: "Tick the file to read it again." }
	it("returns 409 for an unticked failed file", async () => {
		const chat = chatStore.createChat("unticked failed");
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/unticked.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: false,
					status: "failed",
					error: "read failed",
				},
			],
			methods: [],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res = await courseRoute.PATCH(
				patchRequest(chat.id, { path: "/course/unticked.pdf", retry: true }),
				routeCtx(chat.id),
			);
			assert.equal(res.status, 409);
			assert.deepEqual(await res.json(), { error: "Tick the file to read it again." });
			assert.deepEqual(events, []);
			assert.deepEqual(chatStore.getCourseMaterial(chat.id), material);
		} finally {
			off();
		}
	});

	// plan 013 part 1: exactly one of binding, category, retry per body and retry must be true, else 400 with the updated message
	it("returns 400 with the updated error message for retry: false, non-true retry, zero keys, or multiple keys", async () => {
		const chat = chatStore.createChat("bad retry bodies");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/a.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "read failed",
				},
			],
			methods: [],
			conflicts: [],
		});

		for (const badBody of [
			{ path: "/course/a.pdf", retry: false },
			{ path: "/course/a.pdf", retry: "true" },
			{ path: "/course/a.pdf", retry: 1 },
			{ path: "/course/a.pdf" },
			{ path: "/course/a.pdf", binding: true, retry: true },
			{ path: "/course/a.pdf", category: "material", retry: true },
			{ path: "/course/a.pdf", binding: false, category: "exam" },
			{ path: "/course/a.pdf", binding: true, category: "reference", retry: true },
		]) {
			const res = await courseRoute.PATCH(patchRequest(chat.id, badBody), routeCtx(chat.id));
			assert.equal(res.status, 400, JSON.stringify(badBody));
			assert.deepEqual(await res.json(), { error: EXPECTED_400_MESSAGE });
		}
	});

	// plan 013 part 1: unknown chat or unknown path returns 404
	it("returns 404 for unknown chat, missing courseMaterial, or unknown path", async () => {
		const missingChatRes = await courseRoute.PATCH(
			patchRequest("chat_missing", { path: "/course/a.pdf", retry: true }),
			routeCtx("chat_missing"),
		);
		assert.equal(missingChatRes.status, 404);

		const emptyChat = chatStore.createChat("no material");
		const noMaterialRes = await courseRoute.PATCH(
			patchRequest(emptyChat.id, { path: "/course/a.pdf", retry: true }),
			routeCtx(emptyChat.id),
		);
		assert.equal(noMaterialRes.status, 404);

		const chat = chatStore.createChat("unknown path");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: "/course/known.pdf",
					addedAt: "2026-11-22T10:00:00.000Z",
					via: "learner",
					binding: true,
					status: "failed",
					error: "read failed",
				},
			],
			methods: [],
			conflicts: [],
		});

		const unknownPathRes = await courseRoute.PATCH(
			patchRequest(chat.id, { path: "/course/missing.pdf", retry: true }),
			routeCtx(chat.id),
		);
		assert.equal(unknownPathRes.status, 404);
	});
});
