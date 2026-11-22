import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { BreakDivider } from "../components/break-divider.tsx";
import { BreakScreen } from "../components/break-screen.tsx";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { BreakSettings, LhMessage } from "../src/core/index.ts";

const MINUTE_MS = 60_000;

function installDom(mockFetch: typeof globalThis.fetch) {
	const { window: win } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const doc = win.document;

	class StubResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	class StubMutationObserver {
		observe() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	}

	const winRecord = win as unknown as Record<string, unknown>;
	if (!winRecord.ResizeObserver) winRecord.ResizeObserver = StubResizeObserver;
	if (!winRecord.MutationObserver) winRecord.MutationObserver = StubMutationObserver;
	if (!winRecord.requestAnimationFrame) {
		winRecord.requestAnimationFrame = (cb: FrameRequestCallback) =>
			setTimeout(() => cb(0), 0) as unknown as number;
	}
	if (!winRecord.cancelAnimationFrame) {
		winRecord.cancelAnimationFrame = (id: number) => clearTimeout(id);
	}
	if (!winRecord.getComputedStyle) {
		winRecord.getComputedStyle = () =>
			({
				fontSize: "16px",
				lineHeight: "24px",
				paddingTop: "0px",
				paddingBottom: "0px",
				borderTopWidth: "0px",
				borderBottomWidth: "0px",
				overflowX: "visible",
				overflowY: "visible",
				display: "block",
				visibility: "visible",
				maxWidth: "none",
			}) as unknown as CSSStyleDeclaration;
	}
	if (!winRecord.matchMedia) {
		winRecord.matchMedia = () =>
			({
				matches: false,
				media: "",
				onchange: null,
				addListener() {},
				removeListener() {},
				addEventListener() {},
				removeEventListener() {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList;
	}
	if (!winRecord.location) {
		winRecord.location = { hash: "", href: "http://localhost/", pathname: "/", search: "" };
	}
	if (!winRecord.getSelection) {
		winRecord.getSelection = () => null;
	}

	const elProto = win.Element.prototype as unknown as Record<string, unknown>;
	if (!elProto.getAnimations) elProto.getAnimations = () => [];
	if (!elProto.animate) {
		elProto.animate = () => ({
			playState: "finished",
			cancel() {},
			finished: Promise.resolve(),
			effect: null,
		});
	}
	if (!elProto.scrollTo) elProto.scrollTo = () => {};
	if (!elProto.getBoundingClientRect) {
		elProto.getBoundingClientRect = () => ({
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
	}

	const storageMap = new Map<string, string>();
	const storage = {
		getItem: (k: string) => storageMap.get(k) ?? null,
		setItem: (k: string, v: string) => {
			storageMap.set(k, v);
		},
		removeItem: (k: string) => {
			storageMap.delete(k);
		},
		clear: () => {
			storageMap.clear();
		},
		key: (i: number) => [...storageMap.keys()][i] ?? null,
		get length() {
			return storageMap.size;
		},
	};
	if (!winRecord.localStorage) winRecord.localStorage = storage;

	const keys = [
		"window",
		"document",
		"Element",
		"HTMLElement",
		"HTMLInputElement",
		"SVGElement",
		"Node",
		"Text",
		"Event",
		"CustomEvent",
		"KeyboardEvent",
		"MouseEvent",
		"ResizeObserver",
		"MutationObserver",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"getComputedStyle",
		"matchMedia",
		"localStorage",
		"fetch",
	] as const;
	const g = globalThis as Record<string, unknown>;
	const prev = new Map<string, PropertyDescriptor | undefined>();
	for (const k of keys) prev.set(k, Object.getOwnPropertyDescriptor(g, k));

	const assign = (k: string, val: unknown) => {
		Object.defineProperty(g, k, { value: val, configurable: true, writable: true });
	};
	assign("window", win);
	assign("document", doc);
	assign("Element", win.Element);
	assign("HTMLElement", win.HTMLElement);
	assign("HTMLInputElement", win.HTMLInputElement);
	assign("SVGElement", win.SVGElement ?? win.Element);
	assign("Node", win.Node);
	assign("Text", win.Text);
	assign("Event", win.Event);
	assign("CustomEvent", win.CustomEvent);
	assign("KeyboardEvent", win.KeyboardEvent);
	assign("MouseEvent", win.MouseEvent);
	assign("ResizeObserver", winRecord.ResizeObserver);
	assign("MutationObserver", winRecord.MutationObserver);
	assign("requestAnimationFrame", winRecord.requestAnimationFrame);
	assign("cancelAnimationFrame", winRecord.cancelAnimationFrame);
	assign("getComputedStyle", winRecord.getComputedStyle);
	assign("matchMedia", winRecord.matchMedia);
	assign("localStorage", winRecord.localStorage);
	assign("fetch", mockFetch);

	const container = doc.createElement("div");
	doc.body.appendChild(container);
	const root = createRoot(container);

	return {
		win,
		doc,
		container,
		root,
		cleanup() {
			act(() => {
				root.unmount();
			});
			for (const k of keys) {
				const desc = prev.get(k);
				if (desc) Object.defineProperty(g, k, desc);
				else delete g[k];
			}
		},
	};
}

function requestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function breakOfferMessages(learnerAt: number, offerAt: number): LhMessage[] {
	return [
		{ id: "u1", role: "user", content: "Teach me calculus", timestamp: learnerAt },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "brk_1", name: "suggest_break", arguments: { requestedBy: "window" } }],
			api: "faux",
			provider: "synthetic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: offerAt,
		},
		{
			id: "tr1",
			role: "toolResult",
			toolCallId: "brk_1",
			toolName: "suggest_break",
			content: [{ type: "text", text: "Break offered." }],
			details: { ok: true, requestedBy: "window" },
			isError: false,
			timestamp: offerAt,
		},
	];
}

const FIXED_NOW = 1_700_000_000_000;

const dummyRouter = {
	bfcacheId: "",
	back: () => {},
	forward: () => {},
	refresh: () => {},
	push: () => {},
	replace: () => {},
	prefetch: () => {},
};

const noOpEvents = () => ({ close() {}, onOpen() {}, onEvent() {} });

function settingsMockFetch(options?: {
	breaks?: BreakSettings;
	onPut?: (url: string, body: unknown) => void;
}): typeof globalThis.fetch {
	return async (input, init) => {
		const url = requestUrl(input);
		if (url === "/api/settings" && (!init?.method || init.method === "GET")) {
			return Response.json({
				settings: {
					version: 1,
					breaks: options?.breaks ?? { enabled: true, intervalMinutes: 45, lengthMinutes: 10 },
				},
			});
		}
		if (url.startsWith("/api/settings/") && init?.method === "PUT") {
			const parsed = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
			options?.onPut?.(url, parsed);
			const section = url.slice("/api/settings/".length);
			return Response.json({
				settings: { version: 1, [section]: parsed },
			});
		}
		if (url === "/api/models") return Response.json({ models: [], providers: [], slots: {} });
		if (url === "/api/settings/prompts") return Response.json({ teacher: [], prober: [], practice: [] });
		if (url === "/api/keys") return Response.json({ keys: [] });
		if (url === "/api/search") return Response.json({ available: false, engine: null, reason: "" });
		return Response.json({});
	};
}

describe("BreakDivider", () => {
	it("defaults Take button label to 10 min when lengthMinutes is absent (X-0)", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "brk_1", state: "offered" }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.ok(html.includes("Take 10 min"), html);
		assert.ok(!html.includes("Take 5 min"), html);
	});
});

describe("BreakScreen", () => {
	it("uses stroke-primary and filled offset proportional to progress while time remains (X-1, X-2)", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
		const env = installDom(settingsMockFetch());
		try {
			const takenAt = FIXED_NOW - 2 * MINUTE_MS;
			await act(async () => {
				env.root.render(
					<InteractionLayersProvider>
						<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => {}} />
					</InteractionLayersProvider>,
				);
			});
			const circles = env.doc.body.querySelectorAll('[data-testid="break-screen"] svg circle');
			assert.equal(circles.length, 2);
			const ring = circles[1]!;
			assert.equal(ring.getAttribute("class"), "stroke-primary");
			const circumference = 2 * Math.PI * 90;
			const offset = Number(ring.getAttribute("stroke-dashoffset") ?? ring.getAttribute("strokeDashoffset"));
			assert.ok(Number.isFinite(offset) && offset < circumference * 0.4, `expected offset < 0.4*C, got ${offset}`);
		} finally {
			env.cleanup();
		}
	});

	it("uses stroke-muted-foreground once the break is over (X-1)", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
		const env = installDom(settingsMockFetch());
		try {
			const takenAt = FIXED_NOW - 11 * MINUTE_MS;
			await act(async () => {
				env.root.render(
					<InteractionLayersProvider>
						<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => {}} />
					</InteractionLayersProvider>,
				);
			});
			const circles = env.doc.body.querySelectorAll('[data-testid="break-screen"] svg circle');
			assert.equal(circles.length, 2);
			assert.equal(circles[1]!.getAttribute("class"), "stroke-muted-foreground");
		} finally {
			env.cleanup();
		}
	});
});

describe("Chat break integration", () => {
	function chatFetch(
		messages: LhMessage[],
		onBreakPost?: () => Promise<Response>,
	): typeof globalThis.fetch {
		return async (input, init) => {
			const url = requestUrl(input);
			if (url === "/api/settings") {
				return Response.json({ settings: { version: 1 } });
			}
			if (url === "/api/models") return Response.json({ models: [], providers: [], slots: {} });
			if (url.endsWith("/break") && init?.method === "POST") {
				return onBreakPost ? onBreakPost() : Response.json({ ok: true });
			}
			if (url.endsWith("/stats")) return Response.json({ turns: [] });
			if (url.endsWith("/side-chats")) return Response.json({ threads: [], answering: {} });
			if (url.startsWith("/api/jobs")) return Response.json({ jobs: [], turnInFlight: false });
			if (url.startsWith("/api/chats/")) return Response.json({ messages });
			return Response.json({});
		};
	}

	it("shows offered break with Take 10 min, learning clock, and disables buttons while break POST is in flight (X-3, X-4, X-5, X-6)", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
		const now = FIXED_NOW;
		const messages = breakOfferMessages(now - 5 * MINUTE_MS, now - 10_000);
		let resolvePost!: (res: Response) => void;
		const postPromise = new Promise<Response>((resolve) => {
			resolvePost = resolve;
		});
		const env = installDom(chatFetch(messages, () => postPromise));
		try {
			await act(async () => {
				env.root.render(
					<AppRouterContext.Provider value={dummyRouter}>
						<ServerEventsProvider connect={noOpEvents}>
							<InteractionLayersProvider>
								<Chat chatId="c1" title="Calculus" initialMessages={messages} kind="teach" />
							</InteractionLayersProvider>
						</ServerEventsProvider>
					</AppRouterContext.Provider>,
				);
			});
			await flush();

			const learningEl = env.container.querySelector('[data-testid="learning-minutes"]');
			assert.ok(learningEl, "learning-minutes should render in teach sessions");
			assert.match(learningEl.textContent ?? "", /^\d+ min$/);

			const divider = env.container.querySelector('[data-testid="break-divider"]');
			assert.ok(divider, "break-divider should render");
			assert.ok(divider.textContent?.includes("Short break?"), divider.textContent ?? "");

			const buttons = Array.from(divider.querySelectorAll("button")) as HTMLButtonElement[];
			assert.equal(buttons.length, 2);
			assert.equal(buttons[0]!.textContent, "Take 10 min");
			assert.equal(buttons[1]!.textContent, "Skip");
			assert.equal(buttons[0]!.disabled, false);
			assert.equal(buttons[1]!.disabled, false);

			await act(async () => {
				buttons[0]!.click();
			});
			assert.equal(buttons[0]!.disabled, true);
			assert.equal(buttons[1]!.disabled, true);

			await act(async () => {
				resolvePost(Response.json({ ok: true }));
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		} finally {
			env.cleanup();
		}
	});

	it("marks an offered break as skipped when away and hides learning-minutes in practice sessions (X-3, X-4)", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
		const now = FIXED_NOW;
		const awayMessages = breakOfferMessages(now - 25 * MINUTE_MS, now - 20 * MINUTE_MS);
		const envAway = installDom(chatFetch(awayMessages));
		try {
			await act(async () => {
				envAway.root.render(
					<AppRouterContext.Provider value={dummyRouter}>
						<ServerEventsProvider connect={noOpEvents}>
							<InteractionLayersProvider>
								<Chat chatId="c2" title="Calculus" initialMessages={awayMessages} kind="teach" />
							</InteractionLayersProvider>
						</ServerEventsProvider>
					</AppRouterContext.Provider>,
				);
			});
			await flush();
			const divider = envAway.container.querySelector('[data-testid="break-divider"]');
			assert.ok(divider?.textContent?.includes("Break skipped"), divider?.textContent ?? "");
		} finally {
			envAway.cleanup();
		}

		const practiceMessages = breakOfferMessages(now - 5 * MINUTE_MS, now - 10_000);
		const envPractice = installDom(chatFetch(practiceMessages));
		try {
			await act(async () => {
				envPractice.root.render(
					<AppRouterContext.Provider value={dummyRouter}>
						<ServerEventsProvider connect={noOpEvents}>
							<InteractionLayersProvider>
								<Chat chatId="c3" title="Practice" initialMessages={practiceMessages} kind="practice" />
							</InteractionLayersProvider>
						</ServerEventsProvider>
					</AppRouterContext.Provider>,
				);
			});
			await flush();
			assert.equal(envPractice.container.querySelector('[data-testid="learning-minutes"]'), null);
		} finally {
			envPractice.cleanup();
		}
	});
});

describe("AgentSection breaks controls", () => {
	function commitInput(win: Window, input: HTMLInputElement, value: string) {
		input.value = value;
		input.dispatchEvent(new win.Event("input", { bubbles: true }));
		input.dispatchEvent(new win.Event("focusout", { bubbles: true }));
	}

	it("renders stored enabled state, toggles accurately, and snaps/clamps interval and length (X-7, X-8, X-9, X-10, X-11)", async () => {
		const calls: BreakSettings[] = [];
		const envDisabled = installDom(settingsMockFetch());
		try {
			await act(async () => {
				envDisabled.root.render(
					<InteractionLayersProvider>
						<AgentSection
							agent={undefined}
							models={undefined}
							graph={undefined}
							compaction={undefined}
							breaks={{ enabled: false, intervalMinutes: 45, lengthMinutes: 10 }}
							onSectionChange={() => true}
							onModelsChange={() => {}}
							onCompactionChange={() => true}
							onBreaksChange={(next) => {
								calls.push(next);
								return true;
							}}
						/>
					</InteractionLayersProvider>,
				);
			});
			await flush();
			const toggle = envDisabled.container.querySelector('[data-testid="toggle-break-suggestions"]');
			assert.equal(toggle?.getAttribute("aria-checked"), "false");
		} finally {
			envDisabled.cleanup();
		}

		const env = installDom(settingsMockFetch());
		try {
			await act(async () => {
				env.root.render(
					<InteractionLayersProvider>
						<AgentSection
							agent={undefined}
							models={undefined}
							graph={undefined}
							compaction={undefined}
							breaks={{ enabled: true, intervalMinutes: 45, lengthMinutes: 10 }}
							onSectionChange={() => true}
							onModelsChange={() => {}}
							onCompactionChange={() => true}
							onBreaksChange={(next) => {
								calls.push(next);
								return true;
							}}
						/>
					</InteractionLayersProvider>,
				);
			});
			await flush();

			const intervalInput = env.container.querySelector('[data-testid="input-breaks-interval"]') as HTMLInputElement;
			await act(async () => {
				commitInput(env.win as unknown as Window, intervalInput, "38");
			});
			assert.equal(calls.at(-1)?.intervalMinutes, 40);

			const lengthInput = env.container.querySelector('[data-testid="input-breaks-length"]') as HTMLInputElement;
			await act(async () => {
				commitInput(env.win as unknown as Window, lengthInput, "3");
			});
			assert.equal(calls.at(-1)?.lengthMinutes, 5);

			await act(async () => {
				commitInput(env.win as unknown as Window, lengthInput, "60");
			});
			assert.equal(calls.at(-1)?.lengthMinutes, 20);

			const toggle = env.container.querySelector('[data-testid="toggle-break-suggestions"]') as HTMLButtonElement;
			assert.equal(toggle.getAttribute("aria-checked"), "true");
			await act(async () => {
				toggle.click();
			});
			assert.equal(calls.at(-1)?.enabled, false);
		} finally {
			env.cleanup();
		}
	});
});

describe("SettingsDialogBody breaks persistence", () => {
	it("writes break changes to /api/settings/breaks (X-12, X-13)", async () => {
		const puts: Array<{ url: string; body: unknown }> = [];
		const env = installDom(
			settingsMockFetch({
				breaks: { enabled: true, intervalMinutes: 45, lengthMinutes: 10 },
				onPut: (url, body) => puts.push({ url, body }),
			}),
		);
		try {
			await act(async () => {
				env.root.render(
					<InteractionLayersProvider>
						<SettingsDialogBody onClose={() => {}} initialSection="agent" />
					</InteractionLayersProvider>,
				);
			});
			await flush();

			const toggle = env.container.querySelector('[data-testid="toggle-break-suggestions"]') as HTMLButtonElement;
			assert.ok(toggle, "break suggestions toggle should render once settings load");
			assert.equal(toggle.getAttribute("aria-checked"), "true");

			await act(async () => {
				toggle.click();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			assert.equal(puts.length, 1);
			assert.equal(puts[0]!.url, "/api/settings/breaks");
			assert.deepEqual(puts[0]!.body, { enabled: false, intervalMinutes: 45, lengthMinutes: 10 });
			assert.equal(toggle.getAttribute("aria-checked"), "false");
		} finally {
			env.cleanup();
		}
	});
});
