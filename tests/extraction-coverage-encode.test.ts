import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { CoverageRing } from "../components/extraction-coverage.tsx";

function setupDom() {
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
	const container = dom.document.getElementById("root");
	assert.ok(container);
	return {
		container,
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

describe("CoverageRing URL encoding", () => {
	it("encodes reserved characters in chatId when fetching ?view=coverage", async () => {
		const dom = setupDom();
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
		const chatId = "chat/a?b#c";
		try {
			await act(async () => {
				root.render(
					React.createElement(
						InteractionLayersProvider,
						null,
						React.createElement(CoverageRing, { chatId }),
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			assert.ok(
				requestedUrls.includes("/api/chats/chat%2Fa%3Fb%23c?view=coverage"),
				`expected encoded ?view=coverage request, got: ${JSON.stringify(requestedUrls)}`,
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
