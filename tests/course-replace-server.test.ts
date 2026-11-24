import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	createFauxCore,
	createProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import type { CourseMaterial, ServerEvent } from "../src/core/index.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-replace-server-"));
const REAL_TMP = fs.realpathSync.native(TMP_DATA);
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { subscribe } = await import("../src/core/events.ts");
const { piModels } = await import("../src/agent/models.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { assignAddedCourseFiles, assignReplacedCourseFile, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { readFileFingerprint } = await import("../src/server/course-fingerprint.ts");
const courseRoute = await import("../app/api/chats/[id]/course/route.ts");
const replaceRoute = await import("../app/api/chats/[id]/course/replace/route.ts");

const TEST_PROVIDER = "test-replace-provider";
const TEST_API = "test-replace-api" as Api;
const TEST_MODEL: Model<Api> = {
	id: "test-reader",
	name: "Test Reader",
	api: TEST_API,
	provider: TEST_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

let streamDelegate: StreamFunction<Api, SimpleStreamOptions> = () => {
	throw new Error("No test stream handler installed");
};

const dispatchStream: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) =>
	streamDelegate(model, context, options);

piModels().setProvider(
	createProvider({
		id: TEST_PROVIDER,
		name: "Test Replace Provider",
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }),
			},
		},
		models: [TEST_MODEL],
		api: { stream: dispatchStream, streamSimple: dispatchStream },
	}),
);

after(() => {
	piModels().deleteProvider(TEST_PROVIDER);
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function routeCtx(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

function postReplace(id: string, body: unknown): Request {
	return new Request(`http://localhost/api/chats/${id}/course/replace`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function waitFor(cond: () => boolean, timeoutMs = 2000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe("course route change detection", () => {
	it("persists baseline without emitting, and persists and emits course-material-changed when content changes", async () => {
		const chat = chatStore.createChat("get persistence and events");
		const filePath = path.join(REAL_TMP, "checked.md");
		fs.writeFileSync(filePath, "version one", "utf8");

		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: filePath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" }],
			methods: [],
			conflicts: [],
		});

		const events: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "course-material-changed" && e.chatId === chat.id) events.push(e);
		});
		try {
			const res1 = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
			assert.equal(res1.status, 200);
			assert.deepEqual(events, []);
			const saved1 = chatStore.getCourseMaterial(chat.id);
			assert.ok(saved1?.files[0]?.fingerprint);
			assert.equal(Boolean(saved1?.files[0]?.changedOnDisk), false);

			fs.writeFileSync(filePath, "version two, updated", "utf8");
			const res2 = await courseRoute.GET(new Request(`http://localhost/api/chats/${chat.id}/course`), routeCtx(chat.id));
			assert.equal(res2.status, 200);
			assert.equal(events.length, 1);
			const saved2 = chatStore.getCourseMaterial(chat.id);
			assert.equal(saved2?.files[0]?.changedOnDisk, true);
		} finally {
			off();
		}
	});
});

describe("course replace queue and handler integration", () => {
	it("aborts a running oldPath job and queues newPath against all nodes in replace mode", async () => {
		settingsStore.writeSettings({
			version: 1,
			models: { vision: { model: { provider: TEST_PROVIDER, id: TEST_MODEL.id } } },
		});

		const chat = chatStore.createChat("replace running job");
		chatStore.saveTree(chat.id, {
			nodes: [
				{ id: "n1", title: "Node 1" },
				{ id: "n2", title: "Node 2" },
			],
			edges: [],
			version: 1,
		});
		const oldPath = path.join(REAL_TMP, "running-v1.md");
		const newPath = path.join(REAL_TMP, "running-v2.md");
		fs.writeFileSync(oldPath, "# V1\nOld content\n", "utf8");
		fs.writeFileSync(newPath, "# V2\nNew content\n", "utf8");

		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: oldPath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" }],
			methods: [{ nodeId: "n1", path: oldPath, pages: "p. 1", method: "Old n1 route" }],
			conflicts: [],
		});

		let resolveOldStarted!: () => void;
		const oldStarted = new Promise<void>((resolve) => {
			resolveOldStarted = resolve;
		});
		let oldAborted = false;
		let finishOldStream: (() => void) | undefined;
		const seenContexts: string[] = [];

		const newFaux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		newFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(
					JSON.stringify({
						category: "material",
						nodes: [{ nodeId: "n1", pages: "p. 1", method: "New n1 route", sameRouteAsExisting: null, sameAsPreviousVersion: false }],
						newSections: [{ title: "Bonus", pages: "p. 5" }],
					}),
				),
			]),
		]);

		streamDelegate = (model, context, options) => {
			const serialized = JSON.stringify(context);
			if (serialized.includes(oldPath)) {
				resolveOldStarted();
				const stream = createAssistantMessageEventStream();
				const abortedMessage: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "aborted",
					errorMessage: "aborted",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					timestamp: Date.now(),
				};
				const abortNow = () => {
					oldAborted = true;
					stream.push({ type: "error", reason: "aborted", error: abortedMessage });
					stream.end();
				};
				finishOldStream = () => stream.end();
				if (options?.signal?.aborted) abortNow();
				else options?.signal?.addEventListener("abort", abortNow, { once: true });
				return stream;
			}
			seenContexts.push(serialized);
			return newFaux.streamSimple(newFaux.getModel(), context, options);
		};

		try {
			assignAddedCourseFiles(chat.id, [oldPath]);
			await oldStarted;

			const res = await replaceRoute.POST(postReplace(chat.id, { path: oldPath, newPath }), routeCtx(chat.id));
			assert.equal(res.status, 200);

			await waitFor(() => oldAborted, 1500, "running job for oldPath to abort");
			await waitFor(
				() => jobStore.listJobs(chat.id).some((j) => (j.input as { path?: string } | undefined)?.path === newPath && j.status === "done"),
				3000,
				"replacement job to finish",
			);

			const newJob = jobStore.listJobs(chat.id).find((j) => (j.input as { path?: string } | undefined)?.path === newPath);
			assert.ok(newJob);
			assert.deepEqual((newJob.input as { nodeIds?: string[] }).nodeIds, ["n1", "n2"]);
			assert.ok(seenContexts.some((c) => c.includes("This file replaces an earlier version of the same course file.") && c.includes("Old n1 route")));

			const replaced = chatStore.getCourseMaterial(chat.id)?.files.find((f) => f.path === newPath);
			assert.equal(replaced?.status, "assigned");
			assert.deepEqual(replaced?.update?.nodes, [{ nodeId: "n1", kind: "changed" }]);
			assert.deepEqual(replaced?.update?.newSections, [{ title: "Bonus", pages: "p. 5" }]);
		} finally {
			finishOldStream?.();
		}
	});

	it("assignReplacedCourseFile runs on a single-node plan tree", async () => {
		settingsStore.writeSettings({
			version: 1,
			models: { vision: { model: { provider: TEST_PROVIDER, id: TEST_MODEL.id } } },
		});

		const chat = chatStore.createChat("single node replace");
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "only-node", title: "Only node" }],
			edges: [],
			version: 1,
		});
		const filePath = path.join(REAL_TMP, "single-node.md");
		fs.writeFileSync(filePath, "# Single\nRoute\n", "utf8");
		chatStore.setCourseMaterial(chat.id, {
			files: [
				{
					path: filePath,
					addedAt: "2026-11-22T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "pending",
					update: {
						at: "2026-11-24T12:00:00.000Z",
						fromPath: "/course/prev.md",
						previous: [{ nodeId: "only-node", method: "Old route" }],
						revisited: [],
						planAsked: false,
					},
				},
			],
			methods: [],
			conflicts: [],
		});

		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_chunk", { chunk: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(
					JSON.stringify({
						category: "material",
						nodes: [{ nodeId: "only-node", pages: "p. 1", method: "Old route", sameRouteAsExisting: null, sameAsPreviousVersion: true }],
						newSections: [],
					}),
				),
			]),
		]);
		streamDelegate = (_model, context, options) => faux.streamSimple(faux.getModel(), context, options);

		assignReplacedCourseFile(chat.id, filePath);
		await waitFor(
			() => jobStore.listJobs(chat.id).some((j) => (j.input as { path?: string } | undefined)?.path === filePath && j.status === "done"),
			2000,
			"single-node replacement job",
		);

		const job = jobStore.listJobs(chat.id).find((j) => (j.input as { path?: string } | undefined)?.path === filePath);
		assert.deepEqual((job?.input as { nodeIds?: string[] }).nodeIds, ["only-node"]);
		assert.deepEqual(chatStore.getCourseMaterial(chat.id)?.files[0]?.update?.nodes, [{ nodeId: "only-node", kind: "same" }]);
	});

	it("persists changedOnDisk detected before teaching notes on a chat turn", async () => {
		const chat = chatStore.createChat("turn change detection");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "n1", title: "Node 1" }],
			edges: [],
			version: 1,
		});

		const filePath = path.join(REAL_TMP, "turn-check.md");
		fs.writeFileSync(filePath, "initial version", "utf8");
		const fingerprint = await readFileFingerprint(filePath);
		assert.ok(fingerprint);
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: filePath, addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned", fingerprint }],
			methods: [],
			conflicts: [],
		});
		fs.writeFileSync(filePath, "modified on disk before turn", "utf8");

		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("Acknowledged.")])]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const ack = await handleChatRequest(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Hello" } }),
			}),
			(opts) => createTeacherAgent(undefined, { engine, messages: opts.messages }),
		);
		assert.equal(ack.status, 200);
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();

		assert.equal(chatStore.getCourseMaterial(chat.id)?.files[0]?.changedOnDisk, true);
	});
});
