import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";

const require = createRequire(import.meta.url);
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime") as {
	AppRouterContext: React.Context<unknown>;
};
const { PathnameContext } = require("next/dist/shared/lib/hooks-client-context.shared-runtime") as {
	PathnameContext: React.Context<string | null>;
};

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

function snapshotStorage(storage: Storage): Record<string, string> {
	const entries: Record<string, string> = {};
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (key !== null) entries[key] = storage.getItem(key) ?? "";
	}
	return entries;
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

function pointerEvent(win: Window, type: string, clientX: number): Event {
	const PointerCtor = (win as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
	if (PointerCtor) return new PointerCtor(type, { bubbles: true, clientX });
	const MouseCtor = (win as unknown as { MouseEvent?: typeof MouseEvent }).MouseEvent;
	if (MouseCtor) return Object.assign(new MouseCtor(type, { bubbles: true, clientX }), { pointerId: 1 });
	return Object.assign(new win.Event(type, { bubbles: true }), { clientX, pointerId: 1 });
}

function keyEvent(win: Window, key: string): Event {
	const KeyCtor = (win as unknown as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent;
	if (KeyCtor) return new KeyCtor("keydown", { bubbles: true, key });
	return Object.assign(new win.Event("keydown", { bubbles: true }), { key });
}

async function mountSidebar(options: { innerWidth?: number; storage?: Storage } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = options.storage ?? createStorage();
	const navigatorStub = { userAgent: "Mozilla/5.0 Electron/44.0" };

	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
	Object.defineProperty(win, "innerWidth", { configurable: true, writable: true, value: options.innerWidth ?? 1440 });
	Object.defineProperty(win, "innerHeight", { configurable: true, writable: true, value: 900 });
	Object.defineProperty(win, "lh", { configurable: true, writable: true, value: { expandWindow: () => {} } });

	const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
	if (typeof proto.getBoundingClientRect !== "function") {
		proto.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 200, width: 190, height: 20, x: 10, y: 10, toJSON() {} });
	}
	if (typeof proto.focus !== "function") proto.focus = () => {};
	if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};
	if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
	if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};
	for (const metric of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
		if (!(metric in proto)) {
			Object.defineProperty(proto, metric, { configurable: true, get: () => 0, set: () => {} });
		}
	}

	const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/api/chats") return jsonResponse({ chats: [] });
		if (url === "/api/activity") return jsonResponse({ jobs: [], pluginWorkers: [], extractions: [] });
		if (url === "/api/themes") return jsonResponse({ themes: [] });
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

	// Import after navigator is set so module-level IS_ELECTRON is true.
	const { AppShell, SidebarProvider } = await import("../components/sidebar.tsx");

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
				<PathnameContext.Provider value="/">
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

	const aside = container.querySelector("aside") as HTMLElement;
	const innerColumn = aside.firstElementChild as HTMLElement;
	const handle = aside.querySelector('[role="separator"]') as HTMLElement | null;
	return { win, doc, container, storage, aside, innerColumn, handle };
}

describe("sidebar resize handle", () => {
	// plan 016 part 1: inline width from the model instead of w-72 on both the motion wrapper and the inner column
	it("uses inline width from the model instead of w-72 on both wrapper and inner column", async () => {
		const { aside, innerColumn } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(!aside.className.includes("w-72"), "motion wrapper must not use w-72");
		assert.ok(!innerColumn.className.includes("w-72"), "inner column must not use w-72");
		assert.equal(aside.style.width, "288px");
		assert.equal(innerColumn.style.width, "288px");
	});

	// plan 016 part 1: drag changes width live and saves the share on release
	it("updates width live during drag and persists share only on release", async () => {
		const { win, storage, aside, innerColumn, handle } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(handle, "resize handle with role='separator' should render");

		const beforeDragStorage = snapshotStorage(storage);

		await act(async () => {
			handle.dispatchEvent(pointerEvent(win, "pointerdown", 288));
		});
		await act(async () => {
			win.dispatchEvent(pointerEvent(win, "pointermove", 360));
		});

		assert.equal(aside.style.width, "360px");
		assert.equal(innerColumn.style.width, "360px");
		assert.deepEqual(snapshotStorage(storage), beforeDragStorage);

		await act(async () => {
			win.dispatchEvent(pointerEvent(win, "pointerup", 360));
		});

		assert.notDeepEqual(snapshotStorage(storage), beforeDragStorage);

		await cleanup?.();
		cleanup = undefined;

		const remounted = await mountSidebar({ innerWidth: 1440, storage });
		assert.equal(remounted.aside.style.width, "360px");
		assert.equal(remounted.innerColumn.style.width, "360px");
	});

	// plan 016 part 1: the width follows a window resize at a fixed share
	it("scales sidebar width when the window resizes at a fixed share", async () => {
		const { win, aside, innerColumn, handle } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(handle, "resize handle should render");

		await act(async () => {
			handle.dispatchEvent(pointerEvent(win, "pointerdown", 288));
		});
		await act(async () => {
			win.dispatchEvent(pointerEvent(win, "pointermove", 360));
			win.dispatchEvent(pointerEvent(win, "pointerup", 360));
		});

		await act(async () => {
			Object.defineProperty(win, "innerWidth", { configurable: true, writable: true, value: 1200 });
			win.dispatchEvent(new win.Event("resize"));
		});

		assert.equal(aside.style.width, "300px");
		assert.equal(innerColumn.style.width, "300px");
	});

	// plan 016 part 1: keyboard ←/→/Home
	it("adjusts width with ArrowLeft/ArrowRight and resets with Home", async () => {
		const { win, aside, handle } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(handle, "resize handle should render");
		assert.equal(aside.style.width, "288px");

		await act(async () => {
			handle.dispatchEvent(keyEvent(win, "ArrowRight"));
		});
		const afterRight = Number.parseFloat(aside.style.width);
		assert.ok(afterRight > 288, `expected width > 288 after ArrowRight, got ${afterRight}`);

		await act(async () => {
			handle.dispatchEvent(keyEvent(win, "ArrowLeft"));
		});
		const afterLeft = Number.parseFloat(aside.style.width);
		assert.ok(afterLeft < afterRight, `expected width < ${afterRight} after ArrowLeft, got ${afterLeft}`);

		await act(async () => {
			handle.dispatchEvent(keyEvent(win, "ArrowRight"));
			handle.dispatchEvent(keyEvent(win, "Home"));
		});
		assert.equal(aside.style.width, "288px");
	});

	// plan 016 part 1: double-click reset
	it("resets width to default on double-click", async () => {
		const { win, storage, aside, innerColumn, handle } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(handle, "resize handle should render");

		await act(async () => {
			handle.dispatchEvent(pointerEvent(win, "pointerdown", 288));
		});
		await act(async () => {
			win.dispatchEvent(pointerEvent(win, "pointermove", 360));
			win.dispatchEvent(pointerEvent(win, "pointerup", 360));
		});
		assert.equal(aside.style.width, "360px");

		await act(async () => {
			handle.dispatchEvent(new win.Event("dblclick", { bubbles: true }));
		});
		assert.equal(aside.style.width, "288px");
		assert.equal(innerColumn.style.width, "288px");

		await cleanup?.();
		cleanup = undefined;

		const remounted = await mountSidebar({ innerWidth: 1440, storage });
		assert.equal(remounted.aside.style.width, "288px");
	});

	// plan 016 part 1: storage throwing falls back to the default
	it("falls back to default width when localStorage throws", async () => {
		const throwingStorage: Storage = {
			get length() { return 0; },
			clear() {},
			key() { return null; },
			removeItem() {},
			getItem() { throw new Error("storage unavailable"); },
			setItem() { throw new Error("storage unavailable"); },
		};

		const { win, aside, handle } = await mountSidebar({ innerWidth: 1440, storage: throwingStorage });
		assert.equal(aside.style.width, "288px");
		assert.ok(handle, "resize handle should render");

		await act(async () => {
			handle.dispatchEvent(pointerEvent(win, "pointerdown", 288));
			win.dispatchEvent(pointerEvent(win, "pointermove", 340));
			win.dispatchEvent(pointerEvent(win, "pointerup", 340));
			handle.dispatchEvent(new win.Event("dblclick", { bubbles: true }));
		});
		assert.equal(aside.style.width, "288px");
	});

	// plan 016 part 1: auto-close at 879 px and open at 880 px
	it("auto-closes at 879 px and stays open at 880 px", async () => {
		const { win, aside } = await mountSidebar({ innerWidth: 880 });
		assert.equal(aside.getAttribute("aria-hidden"), "false");
		assert.ok(Number.parseFloat(aside.style.width) > 0);

		await act(async () => {
			Object.defineProperty(win, "innerWidth", { configurable: true, writable: true, value: 879 });
			win.dispatchEvent(new win.Event("resize"));
		});
		assert.equal(aside.getAttribute("aria-hidden"), "true");
		assert.equal(Number.parseFloat(aside.style.width), 0);

		await act(async () => {
			Object.defineProperty(win, "innerWidth", { configurable: true, writable: true, value: 880 });
			win.dispatchEvent(new win.Event("resize"));
		});
		assert.equal(aside.getAttribute("aria-hidden"), "false");
		assert.ok(Number.parseFloat(aside.style.width) > 0);
	});

	it("renders the resize handle with lh-no-drag after the lh-drag header band in document order", async () => {
		const { aside, handle } = await mountSidebar({ innerWidth: 1440 });
		assert.ok(handle, "resize handle should render");
		const dragBand = aside.querySelector(".lh-drag") as HTMLElement | null;
		assert.ok(dragBand, "lh-drag header band should render");
		assert.ok(handle.className.split(/\s+/).includes("lh-no-drag"), "resize handle must carry lh-no-drag");
		const order: Element[] = [];
		const visit = (el: Element) => {
			order.push(el);
			for (let child = el.firstElementChild; child; child = child.nextElementSibling) visit(child);
		};
		visit(aside);
		const dragIndex = order.indexOf(dragBand);
		const handleIndex = order.indexOf(handle);
		assert.ok(dragIndex >= 0 && handleIndex > dragIndex, "resize handle must follow the lh-drag element in document order");
	});
});
