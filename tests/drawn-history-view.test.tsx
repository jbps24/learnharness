import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { StickToBottom } from "use-stick-to-bottom";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { SessionMessageNavigation } from "../components/session-navigation.tsx";
import {
	DRAW_STATUS_MIN,
	DRAWN_BUDGET,
	SMALL_REST,
	drawStatusNeeded,
	initialDrawnStart,
	messageAnchorId,
	messageSize,
	showEarlierStart,
	type LhMessage,
} from "../src/core/index.ts";

const dom = parseHTML("<!doctype html><html><head><style></style></head><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;
(globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
(globalThis as Record<string, unknown>).Element = dom.window.Element;
(globalThis as Record<string, unknown>).Node = dom.window.Node;
(globalThis as Record<string, unknown>).Text = dom.window.Text;
(globalThis as Record<string, unknown>).Range = dom.window.Range;
(globalThis as Record<string, unknown>).Event = dom.window.Event;
(globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
(globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as Record<string, unknown>).MouseEvent = dom.window.MouseEvent;
(globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => "", overflow: "visible" });
(globalThis as Record<string, unknown>).CSS = dom.window.CSS ?? { highlights: new Map() };

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}
if (typeof globalThis.MutationObserver === "undefined") {
	globalThis.MutationObserver = class {
		observe() {}
		disconnect() {}
		takeRecords() { return []; }
	} as unknown as typeof MutationObserver;
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
	globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
if (typeof dom.window.matchMedia !== "function") {
	dom.window.matchMedia = () => ({
		matches: false,
		media: "",
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent() { return false; },
	}) as unknown as MediaQueryList;
}
if (typeof dom.window.localStorage === "undefined") {
	const store = new Map<string, string>();
	const storage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => { store.set(k, String(v)); },
		removeItem: (k: string) => { store.delete(k); },
		clear: () => { store.clear(); },
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() { return store.size; },
	};
	(globalThis as Record<string, unknown>).localStorage = storage;
	(globalThis as Record<string, unknown>).sessionStorage = storage;
}
if (typeof dom.window.Element.prototype.getAnimations !== "function") {
	(dom.window.Element.prototype as unknown as { getAnimations(): unknown[] }).getAnimations = () => [];
}
if (!dom.window.location) {
	(dom.window as unknown as Record<string, unknown>).location = { hash: "", pathname: "/", search: "", href: "http://localhost/" };
}
if (typeof dom.window.Element.prototype.scrollTo !== "function") {
	dom.window.Element.prototype.scrollTo = function () {};
}
if (typeof dom.window.Element.prototype.scrollIntoView !== "function") {
	dom.window.Element.prototype.scrollIntoView = function () {};
}
if (typeof dom.window.Element.prototype.getBoundingClientRect !== "function") {
	dom.window.Element.prototype.getBoundingClientRect = function () {
		return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
	};
}
if (typeof dom.window.HTMLElement.prototype.focus !== "function") {
	dom.window.HTMLElement.prototype.focus = function () {};
}

const sizedUserMsg = (id: string, marker: string, targetBytes: number): LhMessage => {
	const base = JSON.stringify({ id, role: "user", content: marker, timestamp: 1 }).length;
	const pad = Math.max(0, targetBytes - base);
	return { id, role: "user", content: `${marker}${"x".repeat(pad)}`, timestamp: 1 } as never;
};

const sizedAssistantMsg = (id: string, marker: string, targetBytes: number): LhMessage => {
	const base = JSON.stringify({ id, role: "assistant", content: [{ type: "text", text: marker }], timestamp: 2 }).length;
	const pad = Math.max(0, targetBytes - base);
	return { id, role: "assistant", content: [{ type: "text", text: `${marker}${"y".repeat(pad)}` }], timestamp: 2 } as never;
};

function makeOverBudgetSession(turnCount = 10, bytesPerMsg = 35_000): LhMessage[] {
	const msgs: LhMessage[] = [];
	for (let i = 0; i < turnCount; i++) {
		msgs.push(sizedUserMsg(`u-${i}`, `USER-TURN-${i}:`, bytesPerMsg));
		msgs.push(sizedAssistantMsg(`a-${i}`, `ASSISTANT-TURN-${i}:`, bytesPerMsg));
	}
	return msgs;
}

const stubRouter: AppRouterInstance = {
	back() {},
	forward() {},
	refresh() {},
	push() {},
	replace() {},
	prefetch() {},
	bfcacheId: undefined as never,
};

function createTestNotifySource() {
	const handlers = new Map<string, Array<(data: string) => void>>();
	const connect = (): NotifySource => ({
		close() {},
		onOpen() {},
		onEvent(name, cb) {
			const list = handlers.get(name) ?? [];
			list.push(cb);
			handlers.set(name, list);
		},
	});
	const emit = (name: string, payload: unknown) => {
		const raw = JSON.stringify(payload);
		for (const cb of handlers.get(name) ?? []) cb(raw);
	};
	return { connect, emit };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

const flushAnimationFrames = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 10))),
	);

describe("drawn-history view (plan 003 part 2)", () => {
	let container: HTMLElement;
	let root: Root | null = null;
	const originalFetch = globalThis.fetch;
	let serverMessages: LhMessage[] = [];

	beforeEach(() => {
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
		serverMessages = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.startsWith("/api/jobs")) {
				return new Response(JSON.stringify({ jobs: [], turnInFlight: false }), { status: 200 });
			}
			if (url.startsWith("/api/models")) {
				return new Response(JSON.stringify({ providers: [], models: [], slots: {} }), { status: 200 });
			}
			if (url.startsWith("/api/settings")) {
				return new Response(JSON.stringify({ settings: {} }), { status: 200 });
			}
			if (url.endsWith("/stats")) {
				return new Response(JSON.stringify({ turns: [] }), { status: 200 });
			}
			if (url.endsWith("/side-chats")) {
				return new Response(JSON.stringify({ threads: [] }), { status: 200 });
			}
			if (url.startsWith("/api/chats/")) {
				return new Response(JSON.stringify({ messages: serverMessages }), { status: 200 });
			}
			return new Response(JSON.stringify({}), { status: 200 });
		}) as typeof fetch;
	});

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root!.unmount();
			});
			root = null;
		}
		globalThis.fetch = originalFetch;
	});

	function mountChat(messages: LhMessage[], chatId = "chat-drawn-test") {
		serverMessages = messages;
		const notify = createTestNotifySource();
		root = createRoot(container);
		act(() => {
			root!.render(
				<InteractionLayersProvider>
					<AppRouterContext.Provider value={stubRouter}>
						<PathnameContext.Provider value={`/chat/${chatId}`}>
							<ServerEventsProvider connect={notify.connect}>
								<Chat chatId={chatId} title="Drawn History Test" initialMessages={messages} />
							</ServerEventsProvider>
						</PathnameContext.Provider>
					</AppRouterContext.Provider>
				</InteractionLayersProvider>,
			);
		});
		return notify;
	}

	// plan 003 part 2 §1: over-budget session hides early messages and renders the newest messages on initial mount
	it("does not render early messages and renders the newest message for an over-budget session", () => {
		const messages = makeOverBudgetSession(10, 35_000);
		assert.ok(initialDrawnStart(messages) > 0);
		mountChat(messages);

		const findRoot = container.querySelector("[data-session-find-root]");
		assert.ok(findRoot, "expected [data-session-find-root] to render");
		const text = findRoot.textContent ?? "";
		assert.equal(text.includes("USER-TURN-0:"), false);
		assert.equal(text.includes("ASSISTANT-TURN-0:"), false);
		assert.equal(text.includes("ASSISTANT-TURN-9:"), true);
	});

	// plan 003 part 2 §1: initialiser runs during SSR so server HTML contains only the drawn history
	it("renders only drawn history during SSR (renderToStaticMarkup)", () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const notify = createTestNotifySource();
		const html = renderToStaticMarkup(
			<InteractionLayersProvider>
				<AppRouterContext.Provider value={stubRouter}>
					<PathnameContext.Provider value="/chat/chat-ssr">
						<ServerEventsProvider connect={notify.connect}>
							<Chat chatId="chat-ssr" title="SSR Test" initialMessages={messages} />
						</ServerEventsProvider>
					</PathnameContext.Provider>
				</AppRouterContext.Provider>
			</InteractionLayersProvider>,
		);
		assert.equal(html.includes("USER-TURN-0:"), false);
		assert.equal(html.includes("ASSISTANT-TURN-9:"), true);
		assert.equal(html.includes("earlier-show"), true);
	});

	// plan 003 part 2 §3: EarlierHistoryDivider renders first inside Find root with data-session-find-exclude and both buttons
	it("renders the EarlierHistoryDivider with its two buttons when over budget, and omits it when under budget", async () => {
		const overBudget = makeOverBudgetSession(10, 35_000);
		mountChat(overBudget, "chat-over");

		const findRoot = container.querySelector("[data-session-find-root]");
		assert.ok(findRoot);
		const showEarlierBtn = findRoot.querySelector('[data-testid="earlier-show"]');
		const showAllBtn = findRoot.querySelector('[data-testid="earlier-show-all"]');
		assert.ok(showEarlierBtn, "expected earlier-show button");
		assert.ok(showAllBtn, "expected earlier-show-all button");
		assert.equal(showEarlierBtn.textContent?.trim(), "Show earlier");
		assert.equal(showAllBtn.textContent?.trim(), "Show all");

		const divider = showEarlierBtn.closest("[data-session-find-exclude]");
		assert.ok(divider, "divider must carry data-session-find-exclude");
		assert.ok(divider.textContent?.includes("Earlier history"));
		assert.equal(findRoot.firstElementChild, divider, "divider renders first inside transcript column");

		await act(async () => {
			root!.unmount();
		});
		root = null;

		// Under budget: divider is absent
		const underBudget = makeOverBudgetSession(2, 1_000);
		assert.equal(initialDrawnStart(underBudget), 0);
		mountChat(underBudget, "chat-under");
		assert.equal(container.querySelector('[data-testid="earlier-show"]'), null);
		assert.equal(container.querySelector('[data-testid="earlier-show-all"]'), null);
	});

	// plan 003 part 2 §3 & owner decision 3: session whose earlier history is under 1/4 budget (SMALL_REST) is drawn whole
	it("omits the divider when earlier history would be under SMALL_REST", () => {
		const msg0 = sizedUserMsg("u-0", "SMALL-REST-USER:", 1_000);
		const msg1 = sizedAssistantMsg("a-0", "SMALL-REST-ASSISTANT:", 1_000);
		const tail = makeOverBudgetSession(4, 35_000);
		const messages = [msg0, msg1, ...tail];
		assert.ok(messageSize(msg0) + messageSize(msg1) < SMALL_REST);
		assert.ok(tail.reduce((s, m) => s + messageSize(m), 0) >= DRAWN_BUDGET);
		assert.equal(initialDrawnStart(messages), 0);

		mountChat(messages, "chat-small-rest");
		assert.equal(container.querySelector('[data-testid="earlier-show"]'), null);
		assert.equal((container.textContent ?? "").includes("SMALL-REST-USER:"), true);
	});

	// plan 003 part 2 §4: Show earlier draws the next step and Show all draws everything
	it("Show earlier draws the next budget step and Show all draws everything", async () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const initStart = initialDrawnStart(messages);
		const stepStart = showEarlierStart(messages, initStart);
		assert.ok(stepStart > 0 && stepStart < initStart, "fixture must have an intermediate step");
		// boundaries fall right after a learner input, so messages[stepStart] is an assistant message
		const stepTurn = (stepStart - 1) / 2;

		mountChat(messages, "chat-show-steps");
		const findRoot = container.querySelector("[data-session-find-root]")!;
		assert.equal((findRoot.textContent ?? "").includes(`ASSISTANT-TURN-${stepTurn}:`), false);

		const showEarlierBtn = findRoot.querySelector('[data-testid="earlier-show"]') as HTMLButtonElement;
		await act(async () => {
			showEarlierBtn.click();
		});

		assert.equal((findRoot.textContent ?? "").includes(`ASSISTANT-TURN-${stepTurn}:`), true);
		assert.equal((findRoot.textContent ?? "").includes(`USER-TURN-${stepTurn}:`), false);
		assert.equal((findRoot.textContent ?? "").includes("USER-TURN-0:"), false);
		assert.ok(findRoot.querySelector('[data-testid="earlier-show-all"]'), "divider remains while start > 0");

		const showAllBtn = findRoot.querySelector('[data-testid="earlier-show-all"]') as HTMLButtonElement;
		await act(async () => {
			showAllBtn.click();
		});

		assert.equal((findRoot.textContent ?? "").includes("USER-TURN-0:"), true);
		assert.equal(findRoot.querySelector('[data-testid="earlier-show"]'), null);
		assert.equal(findRoot.querySelector('[data-testid="earlier-show-all"]'), null);
	});

	// plan 003 part 2 §1: a GET replace with the same messages keeps the start
	it("keeps drawn start unchanged after a GET replace with the same messages", async () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const notify = mountChat(messages, "chat-get-replace");
		const findRoot = container.querySelector("[data-session-find-root]")!;
		assert.equal((findRoot.textContent ?? "").includes("USER-TURN-0:"), false);

		await act(async () => {
			notify.emit("record-changed", { chatId: "chat-get-replace" });
			await flushMicrotasks();
		});

		assert.equal((findRoot.textContent ?? "").includes("USER-TURN-0:"), false);
		assert.equal((findRoot.textContent ?? "").includes("ASSISTANT-TURN-9:"), true);
		assert.ok(findRoot.querySelector('[data-testid="earlier-show"]'));
	});

	// plan 003 part 2 §1 & owner decision 4: an appended message is drawn while earlier history stays undrawn
	it("draws an appended message from a GET sync while keeping earlier history hidden", async () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const notify = mountChat(messages, "chat-append");
		const findRoot = container.querySelector("[data-session-find-root]")!;

		serverMessages = [
			...messages,
			sizedUserMsg("u-10", "USER-TURN-10-APPENDED:", 1_000),
			sizedAssistantMsg("a-10", "ASSISTANT-TURN-10-APPENDED:", 1_000),
		];

		await act(async () => {
			notify.emit("record-changed", { chatId: "chat-append" });
			await flushMicrotasks();
		});

		const text = findRoot.textContent ?? "";
		assert.equal(text.includes("USER-TURN-10-APPENDED:"), true);
		assert.equal(text.includes("ASSISTANT-TURN-10-APPENDED:"), true);
		assert.equal(text.includes("USER-TURN-0:"), false);
	});

	// plan 003 part 2 §5 & owner decision 21: lh:draw-to-message shows Drawing earlier history… for large draws, draws from boundary, and fires lh:drawn-to-message
	it("handles lh:draw-to-message by showing status for slow draws, drawing from the target boundary, and firing lh:drawn-to-message", async () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const initStart = initialDrawnStart(messages);
		// a-0 is index 1, a boundary right after the learner input u-0
		assert.equal(drawStatusNeeded(messages, 1, initStart), true);
		assert.ok(messages.slice(1, initStart).reduce((s, m) => s + messageSize(m), 0) >= DRAW_STATUS_MIN);

		mountChat(messages, "chat-draw-to");
		const findRoot = container.querySelector("[data-session-find-root]")!;
		const drawnEvents: string[] = [];
		const onDrawn = (e: Event) => {
			drawnEvents.push((e as CustomEvent<{ messageId: string }>).detail.messageId);
		};
		window.addEventListener("lh:drawn-to-message", onDrawn);

		const origRaf = globalThis.requestAnimationFrame;
		const frames: FrameRequestCallback[] = [];
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		};
		const runFrame = () => {
			for (const cb of frames.splice(0)) cb(Date.now());
		};

		try {
			await act(async () => {
				window.dispatchEvent(new CustomEvent("lh:draw-to-message", { detail: { messageId: "a-0" } }));
			});

			const statusEl = findRoot.querySelector('[data-testid="drawing-earlier"]');
			assert.ok(statusEl, "expected drawing-earlier status line before animation frames complete");
			assert.equal(statusEl.textContent?.trim(), "Drawing earlier history…");

			await act(async () => {
				runFrame();
			});
			await act(async () => {
				runFrame();
			});

			assert.equal((findRoot.textContent ?? "").includes("USER-TURN-0:"), false);
			assert.equal((findRoot.textContent ?? "").includes("ASSISTANT-TURN-0:"), true);
			assert.equal(findRoot.querySelector('[data-testid="drawing-earlier"]'), null);
			assert.deepEqual(drawnEvents, ["a-0"]);
		} finally {
			globalThis.requestAnimationFrame = origRaf;
			window.removeEventListener("lh:drawn-to-message", onDrawn);
		}
	});

	// plan 003 part 2 §5: a small draw (drawStatusNeeded false) shows no status, still draws and fires lh:drawn-to-message
	it("handles a small lh:draw-to-message without the status line", async () => {
		const messages = makeOverBudgetSession(10, 35_000);
		const initStart = initialDrawnStart(messages);
		const target = messages[initStart - 2]!;
		assert.equal(drawStatusNeeded(messages, initStart - 2, initStart), false);

		mountChat(messages, "chat-draw-small");
		const findRoot = container.querySelector("[data-session-find-root]")!;
		const drawnEvents: string[] = [];
		const onDrawn = (e: Event) => {
			drawnEvents.push((e as CustomEvent<{ messageId: string }>).detail.messageId);
		};
		window.addEventListener("lh:drawn-to-message", onDrawn);

		try {
			await act(async () => {
				window.dispatchEvent(new CustomEvent("lh:draw-to-message", { detail: { messageId: target.id } }));
			});
			assert.equal(findRoot.querySelector('[data-testid="drawing-earlier"]'), null);
			await act(async () => {
				await flushAnimationFrames();
			});
			assert.equal(findRoot.querySelector('[data-testid="drawing-earlier"]'), null);
			assert.equal((findRoot.textContent ?? "").includes(`ASSISTANT-TURN-${(initStart - 3) / 2}:`), true);
			assert.deepEqual(drawnEvents, [target.id]);
		} finally {
			window.removeEventListener("lh:drawn-to-message", onDrawn);
		}
	});

	// plan 003 part 2 §6: SessionMessageNavigation dispatches lh:draw-to-message on mount when hash anchor is absent
	it("SessionMessageNavigation dispatches lh:draw-to-message on mount when hash target is not yet in DOM", async () => {
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			value: { ...originalLocation, hash: `#${messageAnchorId("a-0")}` },
			configurable: true,
		});

		const requests: string[] = [];
		const onDrawRequest = (e: Event) => {
			requests.push((e as CustomEvent<{ messageId: string }>).detail.messageId);
		};
		window.addEventListener("lh:draw-to-message", onDrawRequest);

		try {
			root = createRoot(container);
			await act(async () => {
				root!.render(
					<StickToBottom>
						<SessionMessageNavigation />
						<StickToBottom.Content>
							<div />
						</StickToBottom.Content>
					</StickToBottom>,
				);
			});
			assert.deepEqual(requests, ["a-0"]);
		} finally {
			window.removeEventListener("lh:draw-to-message", onDrawRequest);
			Object.defineProperty(window, "location", { value: originalLocation, configurable: true });
		}
	});

	async function withNavigation(
		initialHash: string,
		body: (ctx: { setHash(hash: string): void; requests: string[]; content: HTMLElement }) => Promise<void>,
		children: React.ReactNode = <div data-testid="nav-content" />,
	) {
		const originalLocation = window.location;
		const loc = { ...originalLocation, hash: initialHash };
		Object.defineProperty(window, "location", { value: loc, configurable: true });
		const requests: string[] = [];
		const onDrawRequest = (e: Event) => {
			requests.push((e as CustomEvent<{ messageId: string }>).detail.messageId);
		};
		window.addEventListener("lh:draw-to-message", onDrawRequest);
		try {
			root = createRoot(container);
			await act(async () => {
				root!.render(
					<StickToBottom>
						<SessionMessageNavigation />
						<StickToBottom.Content>{children}</StickToBottom.Content>
					</StickToBottom>,
				);
			});
			await body({
				setHash: (hash) => { loc.hash = hash; },
				requests,
				content: container.querySelector('[data-testid="nav-content"]') as HTMLElement,
			});
		} finally {
			window.removeEventListener("lh:draw-to-message", onDrawRequest);
			Object.defineProperty(window, "location", { value: originalLocation, configurable: true });
		}
	}

	// plan 003 part 2 §6: no draw request when the anchor is already in the DOM
	it("SessionMessageNavigation does not request a draw when the hash anchor already exists", async () => {
		await withNavigation(
			`#${messageAnchorId("a-0")}`,
			async ({ requests }) => {
				assert.deepEqual(requests, []);
			},
			<div data-testid="nav-content"><div id={messageAnchorId("a-0")} /></div>,
		);
	});

	// plan 003 part 2 §6: a hash without a message id never requests a draw
	it("SessionMessageNavigation does not request a draw for a hash with no message id", async () => {
		await withNavigation("#not-a-message", async ({ requests, setHash }) => {
			assert.deepEqual(requests, []);
			setHash("#still-not-a-message");
			await act(async () => {
				window.dispatchEvent(new Event("hashchange"));
			});
			assert.deepEqual(requests, []);
		});
	});

	// plan 003 part 2 §6: a later hashchange to an undrawn message requests a draw and jumps once drawn
	it("SessionMessageNavigation requests a draw on hashchange and jumps when the draw lands", async () => {
		await withNavigation("", async ({ requests, setHash, content }) => {
			assert.deepEqual(requests, []);
			setHash(`#${messageAnchorId("a-0")}`);
			await act(async () => {
				window.dispatchEvent(new Event("hashchange"));
			});
			assert.deepEqual(requests, ["a-0"]);

			const anchor = document.createElement("div");
			anchor.id = messageAnchorId("a-0");
			content.appendChild(anchor);
			assert.equal(anchor.classList.contains("lh-source-highlight"), false);
			await act(async () => {
				window.dispatchEvent(new CustomEvent("lh:drawn-to-message", { detail: { messageId: "a-0" } }));
			});
			assert.equal(anchor.classList.contains("lh-source-highlight"), true);
		});
	});

	// plan 003 part 2 §4: Show earlier keeps the reader's place; a draw-to-message does not touch scroll
	describe("scroll position", () => {
		const ancestors = (el: Element) => {
			const list: Element[] = [];
			for (let e = el.parentElement; e; e = e.parentElement) list.push(e);
			return list;
		};
		const top = (el: Element) => (el as unknown as { scrollTop: number }).scrollTop;
		beforeEach(() => {
			Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
				configurable: true,
				get() { return (this as HTMLElement).textContent?.length ?? 0; },
			});
		});
		afterEach(() => {
			delete (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
		});

		it("Show earlier moves scrollTop down by the height that was prepended", async () => {
			mountChat(makeOverBudgetSession(10, 35_000), "chat-keep-scroll");
			const findRoot = container.querySelector("[data-session-find-root]")!;
			const scrollers = ancestors(findRoot);
			for (const s of scrollers) (s as unknown as { scrollTop: number }).scrollTop = 100;
			const before = new Map(scrollers.map((s) => [s, (s as HTMLElement).scrollHeight]));

			await act(async () => {
				(findRoot.querySelector('[data-testid="earlier-show"]') as HTMLButtonElement).click();
			});

			const moved = scrollers.filter((s) => top(s) !== 100);
			assert.ok(moved.length > 0, "expected the transcript scroller to be adjusted");
			for (const s of moved) {
				const grown = (s as HTMLElement).scrollHeight - before.get(s)!;
				assert.ok(grown > 0);
				assert.equal(top(s), 100 + grown);
			}
		});

		it("a draw-to-message leaves scrollTop alone", async () => {
			const messages = makeOverBudgetSession(10, 35_000);
			const initStart = initialDrawnStart(messages);
			mountChat(messages, "chat-draw-no-keep");
			const findRoot = container.querySelector("[data-session-find-root]")!;
			const scrollers = ancestors(findRoot);
			for (const s of scrollers) (s as unknown as { scrollTop: number }).scrollTop = 100;

			await act(async () => {
				window.dispatchEvent(new CustomEvent("lh:draw-to-message", { detail: { messageId: messages[initStart - 2]!.id } }));
				await flushAnimationFrames();
			});

			for (const s of scrollers) assert.equal(top(s), 100);
		});
	});
});
