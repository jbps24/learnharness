import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { newUserMessage } from "../src/core/native-messages.ts";

const testData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-small-views-"));
process.env.LH_DATA_DIR = testData;
after(() => fs.rmSync(testData, { recursive: true, force: true }));

const { GET } = await import("../app/api/chats/[id]/route.ts");
const { stores, sessionCoverage } = await import("../src/server/index.ts");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { ModelControl } = await import("../components/model-picker.tsx");
const { CoverageRing } = await import("../components/extraction-coverage.tsx");

function installDom() {
	const dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>");
	const g = globalThis as Record<string, unknown>;
	const keys = ["window", "document", "Element", "HTMLElement", "Node"] as const;
	const prev = new Map<string, PropertyDescriptor | undefined>();
	for (const key of keys) {
		prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		g[key] = (dom as unknown as Record<string, unknown>)[key];
	}
	const prevAct = g.IS_REACT_ACT_ENVIRONMENT;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	return {
		container: dom.document.getElementById("root")!,
		restore() {
			for (const key of keys) {
				const desc = prev.get(key);
				if (desc) Object.defineProperty(globalThis, key, desc);
				else delete g[key];
			}
			if (prevAct === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
			else g.IS_REACT_ACT_ENVIRONMENT = prevAct;
		},
	};
}

describe("GET /api/chats/[id] small views", () => {
	const chat = stores.chatStore.createChat("Small views test");
	const settings = {
		model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
		thinkingLevel: "low" as const,
	};
	stores.chatStore.saveSettings(chat.id, settings);
	stores.chatStore.saveMessages(chat.id, [newUserMessage("hello")]);

	// plan 003 part 3: ?view=settings returns { settings: chat.settings } without messages
	it("?view=settings returns only { settings } and omits messages", async () => {
		const res = await GET(
			new Request(`http://localhost/api/chats/${chat.id}?view=settings`),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepEqual(Object.keys(body), ["settings"]);
		assert.deepEqual(body.settings, settings);
		assert.equal("messages" in body, false);
	});

	// plan 003 part 3: ?view=settings returns 404 { error: "Not found" } for a missing chat
	it("?view=settings returns 404 for a missing chat", async () => {
		const res = await GET(
			new Request("http://localhost/api/chats/missing-chat-id?view=settings"),
			{ params: Promise.resolve({ id: "missing-chat-id" }) },
		);
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "Not found" });
	});

	// plan 003 part 3: ?view=coverage returns { coverage: sessionCoverage(id) } without messages
	it("?view=coverage returns only { coverage } and omits messages", async () => {
		const expected = sessionCoverage(chat.id);
		assert.ok(expected);
		const res = await GET(
			new Request(`http://localhost/api/chats/${chat.id}?view=coverage`),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepEqual(Object.keys(body), ["coverage"]);
		assert.deepEqual(body.coverage, expected);
		assert.equal("messages" in body, false);
	});

	// plan 003 part 3: ?view=coverage returns 404 { error: "Not found" } for a missing chat
	it("?view=coverage returns 404 for a missing chat", async () => {
		const res = await GET(
			new Request("http://localhost/api/chats/missing-chat-id?view=coverage"),
			{ params: Promise.resolve({ id: "missing-chat-id" }) },
		);
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "Not found" });
	});
});

describe("component small-view requests", () => {
	// plan 003 part 3: ModelControl (readRecord) fetches /api/chats/${chatId}?view=settings
	it("ModelControl requests /api/chats/${chatId}?view=settings", async () => {
		const dom = installDom();
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestedUrls.push(url);
			if (url === "/api/models") {
				return Response.json({ models: [], defaults: {}, providers: [], slots: {} });
			}
			if (url === "/api/settings") {
				return Response.json({ settings: null });
			}
			return Response.json({ settings: {} });
		}) as typeof fetch;

		const root = createRoot(dom.container);
		try {
			await act(async () => {
				root.render(
					React.createElement(
						InteractionLayersProvider,
						null,
						React.createElement(ModelControl, { chatId: "chat-settings-view" }),
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			assert.ok(
				requestedUrls.includes("/api/chats/chat-settings-view?view=settings"),
				`expected ?view=settings request, got: ${JSON.stringify(requestedUrls)}`,
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			globalThis.fetch = originalFetch;
			dom.restore();
		}
	});

	// plan 003 part 3: CoverageRing (fetchCoverage) fetches /api/chats/${chatId}?view=coverage
	it("CoverageRing requests /api/chats/${chatId}?view=coverage", async () => {
		const dom = installDom();
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestedUrls.push(url);
			if (url === "/api/settings") {
				return Response.json({ settings: null });
			}
			return Response.json({
				coverage: {
					totalMessages: 0,
					coveredCount: 0,
					uncoveredCount: 0,
					coveredTokens: 0,
					uncoveredTokens: 0,
					running: false,
					lastFoldedAt: null,
				},
			});
		}) as typeof fetch;

		const root = createRoot(dom.container);
		try {
			await act(async () => {
				root.render(
						React.createElement(
							InteractionLayersProvider,
							null,
							React.createElement(CoverageRing, { chatId: "chat-coverage-view" }),
						),
					);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			assert.ok(
				requestedUrls.includes("/api/chats/chat-coverage-view?view=coverage"),
				`expected ?view=coverage request, got: ${JSON.stringify(requestedUrls)}`,
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			globalThis.fetch = originalFetch;
			dom.restore();
		}
	});
});
