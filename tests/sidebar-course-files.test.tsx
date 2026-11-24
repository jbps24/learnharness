import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { AppShell, SidebarProvider } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/contracts/chat.ts";
import type { CourseMaterial } from "../src/core/contracts/course.ts";

const require = createRequire(import.meta.url);
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime") as {
	AppRouterContext: React.Context<unknown>;
};
const { PathnameContext } = require("next/dist/shared/lib/hooks-client-context.shared-runtime") as {
	PathnameContext: React.Context<string | null>;
};

interface CourseResponse {
	material: CourseMaterial | null;
	nodes: Array<{ id: string; title: string }>;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

function createStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear() { map.clear(); },
		getItem(key: string) { return map.get(key) ?? null; },
		key(index: number) { return [...map.keys()][index] ?? null; },
		removeItem(key: string) { map.delete(key); },
		setItem(key: string, value: string) { map.set(key, value); },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function flush(rounds = 3) {
	for (let i = 0; i < rounds; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

class StubObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() { return []; }
}

async function mountSidebar(options: {
	pathname: string;
	chats: ChatListItem[];
	courses: Record<string, CourseResponse>;
}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = createStorage();
	const navigatorStub = { userAgent: "node-test" };

	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
	Object.defineProperty(win, "innerWidth", { configurable: true, writable: true, value: 1280 });
	Object.defineProperty(win, "innerHeight", { configurable: true, writable: true, value: 800 });

	const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
	if (typeof proto.getBoundingClientRect !== "function") {
		proto.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 200, width: 190, height: 20, x: 10, y: 10, toJSON() {} });
	}
	if (typeof proto.focus !== "function") proto.focus = () => {};
	if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};
	for (const metric of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
		if (!(metric in proto)) {
			Object.defineProperty(proto, metric, { configurable: true, get: () => 0, set: () => {} });
		}
	}
	const inputProto = win.HTMLInputElement.prototype as unknown as Record<string, unknown>;
	if (typeof inputProto.select !== "function") inputProto.select = () => {};

	const courseFetches: string[] = [];
	const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/api/chats") return jsonResponse({ chats: options.chats });
		const courseMatch = /^\/api\/chats\/([^/]+)\/course$/.exec(url);
		if (courseMatch) {
			const chatId = decodeURIComponent(courseMatch[1]!);
			courseFetches.push(chatId);
			return jsonResponse(options.courses[chatId] ?? { material: null, nodes: [] });
		}
		if (url === "/api/activity") return jsonResponse({ jobs: [], pluginWorkers: [], extractions: [] });
		if (url === "/api/themes") return jsonResponse({ themes: [] });
		if (url.includes("view=coverage")) return jsonResponse({}, 409);
		return jsonResponse({}, 404);
	};

	const source: NotifySource = { close() {}, onOpen() {}, onEvent() {} };

	const globals: Record<string, unknown> = {
		React,
		window: win,
		self: win,
		document: doc,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
		Node: win.Node,
		HTMLInputElement: win.HTMLInputElement,
		HTMLTextAreaElement: win.HTMLTextAreaElement ?? win.HTMLElement,
		Event: win.Event,
		MouseEvent: win.MouseEvent,
		CustomEvent: win.CustomEvent,
		localStorage: storage,
		navigator: navigatorStub,
		fetch: fetchImpl,
		ResizeObserver: StubObserver,
		MutationObserver: StubObserver,
		IntersectionObserver: StubObserver,
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	const routerStub = {
		back: () => {},
		forward: () => {},
		refresh: () => {},
		push: () => {},
		replace: () => {},
		prefetch: () => {},
	};

	const container = doc.getElementById("root")!;
	const root = createRoot(container);

	await act(async () => {
		root.render(
			<AppRouterContext.Provider value={routerStub}>
				<PathnameContext.Provider value={options.pathname}>
					<ServerEventsProvider connect={() => source}>
						<SidebarProvider>
							<AppShell>
								<div />
							</AppShell>
						</SidebarProvider>
					</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
	await flush();

	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return { win, doc, container, courseFetches };
}

describe("Sidebar SessionCourseFiles integration", () => {
	it("passes active only to the open session and keeps the files dropdown visible while renaming", async () => {
		const chats: ChatListItem[] = [
			{
				id: "chat-1",
				title: "Algebra",
				createdAt: "2026-11-22T10:00:00.000Z",
				updatedAt: "2026-11-23T10:00:00.000Z",
				kind: "teach",
				messageCount: 2,
				phase: "teach",
				pendingQuestion: false,
				pendingProblem: false,
				busy: false,
				compacting: false,
			},
			{
				id: "chat-2",
				title: "Calculus",
				createdAt: "2026-11-22T09:00:00.000Z",
				updatedAt: "2026-11-23T09:00:00.000Z",
				kind: "teach",
				messageCount: 2,
				phase: "teach",
				pendingQuestion: false,
				pendingProblem: false,
				busy: false,
				compacting: false,
			},
		];

		const h = await mountSidebar({
			pathname: "/chat/chat-1",
			chats,
			courses: {
				"chat-1": {
					material: {
						files: [
							{ path: "/course/active.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
						],
						methods: [],
						conflicts: [],
					},
					nodes: [],
				},
				"chat-2": {
					material: {
						files: [
							{ path: "/course/other-1.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
							{ path: "/course/other-2.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
						],
						methods: [],
						conflicts: [],
					},
					nodes: [],
				},
			},
		});

		assert.deepEqual(h.courseFetches, ["chat-1"], "only the active session fetches its course files");
		const initialBlocks = [...h.doc.querySelectorAll('[data-testid="session-course-files"]')];
		assert.equal(initialBlocks.length, 1);
		assert.ok(initialBlocks[0]!.textContent?.includes("Files (1)"));

		const row = h.doc.querySelector<HTMLButtonElement>('[data-session-id="chat-1"]');
		assert.ok(row, "Expected active session row");
		await act(async () => {
			row.dispatchEvent(new h.win.Event("contextmenu", { bubbles: true, cancelable: true }));
		});
		await flush();

		const renameButton = h.doc.querySelector<HTMLButtonElement>('[data-testid="ctx-rename"]');
		assert.ok(renameButton, "Expected context menu Rename button");
		await act(async () => {
			renameButton.click();
		});
		await flush();

		const renameRow = h.doc.querySelector('[data-testid="session-rename-row"]');
		assert.ok(renameRow, "Expected inline RenameRow to be visible");

		const blocksWhileRenaming = [...h.doc.querySelectorAll('[data-testid="session-course-files"]')];
		assert.equal(blocksWhileRenaming.length, 1, "Files dropdown stays visible while renaming");
		assert.ok(blocksWhileRenaming[0]!.textContent?.includes("Files (1)"));
	});
});
