import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { NewSession } from "../components/new-session.tsx";
import type { GraphSnapshot } from "../src/core/contracts/graph.ts";
import type { SourceDirectory } from "../src/core/index.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function mountPracticeDraft(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const navigatorStub = { userAgent: "node-test" };

	let active: Element | null = doc.body;
	Object.defineProperty(doc, "activeElement", { configurable: true, get: () => active });

	const prototype = win.HTMLElement.prototype;
	const originalFocus = prototype.focus;
	const originalSetAttribute = prototype.setAttribute;
	const legacyInputDescriptors = new Map(["attachEvent", "detachEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
	Object.assign(prototype, { attachEvent() {}, detachEvent() {} });
	prototype.setAttribute = function (name: string, value: string) { originalSetAttribute.call(this, name.toLowerCase(), value); };
	prototype.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		active = this;
		this.dispatchEvent(new win.Event("focusin", { bubbles: true }));
	};

	const style = (element: HTMLElement) => ({
		display: element.style.display || "block",
		visibility: element.style.visibility || "visible",
		position: element.style.position || "static",
		overflow: element.style.overflow || "visible",
		paddingLeft: "0px",
		paddingRight: "0px",
		marginLeft: "0px",
		marginRight: "0px",
		borderLeftWidth: "0px",
		borderRightWidth: "0px",
	});

	class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
	Object.assign(win, { getComputedStyle: style, innerWidth: 1200, ResizeObserver: ResizeObserverStub });

	const source: NotifySource = {
		close() {},
		onOpen() {},
		onEvent() {},
	};

	const globals: Record<string, unknown> = {
		React,
		window: win,
		self: win,
		document: doc,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
		Node: win.Node,
		HTMLInputElement: win.HTMLInputElement,
		Event: win.Event,
		MouseEvent: win.MouseEvent,
		CustomEvent: win.CustomEvent,
		MutationObserver: win.MutationObserver,
		ResizeObserver: ResizeObserverStub,
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		getComputedStyle: style,
		navigator: navigatorStub,
		fetch: fetchImpl,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	const routerStub = {
		bfcacheId: "exam-badge-fixture",
		back() {},
		forward() {},
		refresh() {},
		push() {},
		replace() {},
		prefetch() {},
	};

	const container = doc.getElementById("root")!;
	const root = createRoot(container);

	await act(async () => {
		root.render(
			<AppRouterContext.Provider value={routerStub}>
				<PathnameContext.Provider value="/chat/new">
					<InteractionLayersProvider>
						<ServerEventsProvider connect={() => source}>
							<NewSession initialConfigured={true} mode="practice" />
						</ServerEventsProvider>
					</InteractionLayersProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
	await flush();

	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		prototype.focus = originalFocus;
		prototype.setAttribute = originalSetAttribute;
		for (const [key, descriptor] of legacyInputDescriptors) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return { doc };
}

describe("ExamPickerBadge", () => {
	// plan 010 part 4: Practice picker shows exam ×N after proposition text, omits it at 0, and makes no automatic selection
	it("shows exam ×N badge for propositions with coverage, omits it at 0, and makes no automatic selection", async () => {
		const snapshot: GraphSnapshot = {
			nodes: [
				{ id: "p1", name: "Prop One", statement: "First statement.", aliases: [], createdAt: "2026-11-22T10:00:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m1" }] },
				{ id: "p2", name: "Prop Two", statement: "Second statement.", aliases: [], createdAt: "2026-11-22T10:01:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m2" }] },
				{ id: "p3", name: "Prop Three", statement: "Third statement.", aliases: [], createdAt: "2026-11-22T10:02:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m3" }] },
			],
			propositions: [
				{ id: "p1", name: "Prop One", statement: "First statement.", aliases: [], createdAt: "2026-11-22T10:00:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m1" }] },
				{ id: "p2", name: "Prop Two", statement: "Second statement.", aliases: [], createdAt: "2026-11-22T10:01:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m2" }] },
				{ id: "p3", name: "Prop Three", statement: "Third statement.", aliases: [], createdAt: "2026-11-22T10:02:00.000Z", provenance: [{ chatId: "chat-a", messageId: "m3" }] },
			],
			edges: [],
			logicalEdges: [],
			impLinks: [],
			chains: [
				{ id: "arg_1", premises: ["p1", "p2"], conclusion: "p3", provenance: [{ chatId: "chat-a", messageId: "" }], createdAt: "2026-11-22T10:02:00.000Z" },
			],
			sessions: { "chat-a": "Linear Algebra" },
			fileSources: {},
			nodeSessions: { p1: ["chat-a"], p2: ["chat-a"], p3: ["chat-a"] },
			clusters: [],
		};
		const directory: SourceDirectory = {
			sources: [{ id: "chat-a", kind: "chat", label: "Linear Algebra", createdAt: "2026-11-22T10:00:00.000Z" }],
			organization: { version: 1, folders: [], placements: {} },
		};

		const h = await mountPracticeDraft(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/api/graph/sources")) return jsonResponse(directory);
			if (url.includes("/api/graph")) return jsonResponse(snapshot);
			if (url.includes("/api/practice/exam-coverage")) return jsonResponse({ counts: { p1: 2, p3: 1 } });
			if (url.includes("/api/models")) return jsonResponse({ providers: [], models: [], slots: {} });
			return jsonResponse({});
		});

		const chip = h.doc.querySelector<HTMLButtonElement>('[data-testid="practice-props-chip"]');
		assert.ok(chip, "Expected Pick nodes button");
		await act(async () => {
			chip.click();
		});
		await flush();

		const clusterToggle = h.doc.querySelector<HTMLButtonElement>('[data-testid="cluster-toggle-chat-a"]');
		assert.ok(clusterToggle, "Expected cluster toggle");
		await act(async () => {
			clusterToggle.click();
		});

		const chainToggle = h.doc.querySelector<HTMLButtonElement>('[data-testid="chain-toggle-arg_1"]');
		assert.ok(chainToggle, "Expected chain toggle");
		await act(async () => {
			chainToggle.click();
		});

		const row1 = h.doc.querySelector('[data-testid="prop-row-p1"]');
		const row2 = h.doc.querySelector('[data-testid="prop-row-p2"]');
		const row3 = h.doc.querySelector('[data-testid="prop-row-p3"]');
		assert.ok(row1 && row2 && row3, "Expected all three proposition rows");

		const text1 = row1.textContent ?? "";
		assert.ok(text1.includes("First statement."));
		assert.ok(text1.includes("exam ×2"), "Shows exam ×2 badge for p1");
		assert.ok(text1.indexOf("First statement.") < text1.indexOf("exam ×2"), "Badge appears after proposition text");

		const text2 = row2.textContent ?? "";
		assert.ok(text2.includes("Second statement."));
		assert.equal(text2.includes("exam ×"), false, "No badge when count is 0 / omitted");

		const text3 = row3.textContent ?? "";
		assert.ok(text3.includes("Third statement."));
		assert.ok(text3.includes("exam ×1"), "Shows exam ×1 badge for p3");

		// No automatic selection
		for (const id of ["p1", "p2", "p3"]) {
			const cb = h.doc.querySelector<HTMLInputElement>(`[data-testid="prop-checkbox-${id}"]`);
			assert.equal(cb?.checked, false, `${id} is not automatically selected`);
		}
		assert.equal(h.doc.querySelector('[data-testid="chain-selection-bar"]'), null);
	});

	// plan 010 part 4: an explicit count of 0 shows no badge
	it("shows no badge for a proposition whose count is 0", async () => {
		const prop = (id: string, statement: string, messageId: string) => ({ id, name: id, statement, aliases: [], createdAt: "2026-11-22T10:00:00.000Z", provenance: [{ chatId: "chat-a", messageId }] });
		const snapshot: GraphSnapshot = {
			nodes: [prop("p1", "First statement.", "m1"), prop("p2", "Second statement.", "m2")],
			propositions: [prop("p1", "First statement.", "m1"), prop("p2", "Second statement.", "m2")],
			edges: [],
			logicalEdges: [],
			impLinks: [],
			chains: [{ id: "arg_1", premises: ["p1"], conclusion: "p2", provenance: [{ chatId: "chat-a", messageId: "" }], createdAt: "2026-11-22T10:02:00.000Z" }],
			sessions: { "chat-a": "Linear Algebra" },
			fileSources: {},
			nodeSessions: { p1: ["chat-a"], p2: ["chat-a"] },
			clusters: [],
		};
		const directory: SourceDirectory = {
			sources: [{ id: "chat-a", kind: "chat", label: "Linear Algebra", createdAt: "2026-11-22T10:00:00.000Z" }],
			organization: { version: 1, folders: [], placements: {} },
		};

		const h = await mountPracticeDraft(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/api/graph/sources")) return jsonResponse(directory);
			if (url.includes("/api/graph")) return jsonResponse(snapshot);
			if (url.includes("/api/practice/exam-coverage")) return jsonResponse({ counts: { p1: 1, p2: 0 } });
			if (url.includes("/api/models")) return jsonResponse({ providers: [], models: [], slots: {} });
			return jsonResponse({});
		});

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[data-testid="practice-props-chip"]')!.click();
		});
		await flush();
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[data-testid="cluster-toggle-chat-a"]')!.click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[data-testid="chain-toggle-arg_1"]')!.click();
		});

		assert.ok((h.doc.querySelector('[data-testid="prop-row-p1"]')?.textContent ?? "").includes("exam ×1"));
		const text2 = h.doc.querySelector('[data-testid="prop-row-p2"]')?.textContent ?? "";
		assert.ok(text2.includes("Second statement."));
		assert.equal(text2.includes("exam ×"), false);
	});
});
