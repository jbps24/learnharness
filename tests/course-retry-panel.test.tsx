import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { SessionCourseFiles } from "../components/session-course-files.tsx";
import type { CourseMaterial } from "../src/core/contracts/course.ts";

interface CourseResponse {
	material: CourseMaterial | null;
	nodes: Array<{ id: string; title: string }>;
	lessonNodes?: Array<{ lessonId: string; id: string; title: string }>;
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

async function mountHarness(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = createStorage();
	const navigatorStub = { userAgent: "node-test" };

	let active: Element | null = doc.body;
	Object.defineProperty(doc, "activeElement", { configurable: true, get: () => active });

	const prototype = win.HTMLElement.prototype;
	const originalFocus = prototype.focus;
	const originalSetAttribute = prototype.setAttribute;
	const originalGetBoundingClientRect = prototype.getBoundingClientRect;
	const legacyInputDescriptors = new Map(["attachEvent", "detachEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
	Object.assign(prototype, { attachEvent() {}, detachEvent() {} });
	prototype.setAttribute = function (name: string, value: string) { originalSetAttribute.call(this, name.toLowerCase(), value); };
	prototype.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		active = this;
	};
	prototype.getBoundingClientRect = function () {
		return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON() {} } as DOMRect;
	};

	const style = (element: HTMLElement) => ({
		display: element.style.display || "block",
		visibility: element.style.visibility || "visible",
		position: element.style.position || "static",
		overflow: element.style.overflow || "visible",
		animationName: "none",
			paddingLeft: "0px",
		paddingRight: "0px",
		marginLeft: "0px",
		marginRight: "0px",
		borderLeftWidth: "0px",
		borderRightWidth: "0px",
	});

	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const PointerEventCtor = win.PointerEvent ?? win.MouseEvent;
	const raf = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
	const caf = (id: number) => clearTimeout(id);

	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
	Object.assign(win, {
		getComputedStyle: style,
		innerWidth: 1200,
		ResizeObserver: ResizeObserverStub,
		PointerEvent: PointerEventCtor,
		KeyboardEvent: win.KeyboardEvent ?? class extends win.Event {
			key: string;
			constructor(type: string, init: { key?: string; bubbles?: boolean } = {}) {
				super(type, init);
				this.key = init.key ?? "";
			}
		},
		requestAnimationFrame: raf,
		cancelAnimationFrame: caf,
	});
	if (!win.PointerEvent) Object.assign(win, { PointerEvent: win.Event });

	const listeners = new Map<string, Array<(data: string) => void>>();
	const source: NotifySource = {
		close() {},
		onOpen() {},
		onEvent(name, cb) {
			const list = listeners.get(name) ?? [];
			list.push(cb);
			listeners.set(name, list);
		},
	};

	const globals: Record<string, unknown> = {
		React,
		window: win,
		self: win,
		document: doc,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
			SVGElement: win.SVGElement,
			ShadowRoot: win.ShadowRoot,
		Node: win.Node,
		HTMLInputElement: win.HTMLInputElement,
		Event: win.Event,
		MouseEvent: win.MouseEvent,
		KeyboardEvent: win.KeyboardEvent,
		PointerEvent: PointerEventCtor,
		CustomEvent: win.CustomEvent,
		MutationObserver: win.MutationObserver,
		ResizeObserver: ResizeObserverStub,
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		getComputedStyle: style,
		requestAnimationFrame: raf,
		cancelAnimationFrame: caf,
		localStorage: storage,
		navigator: navigatorStub,
		fetch: fetchImpl,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	if (!globals.PointerEvent) globals.PointerEvent = win.Event;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	const container = doc.getElementById("root")!;
	const root = createRoot(container);

	await act(async () => {
		root.render(
			<InteractionLayersProvider>
				<ServerEventsProvider connect={() => source}>
					<SessionCourseFiles chatId="chat-1" active={true} />
				</ServerEventsProvider>
			</InteractionLayersProvider>,
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
		prototype.getBoundingClientRect = originalGetBoundingClientRect;
		for (const [key, descriptor] of legacyInputDescriptors) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return {
		win,
		doc,
		emitEvent(name: string, payload: unknown) {
			const raw = JSON.stringify(payload);
			for (const cb of listeners.get(name) ?? []) cb(raw);
		},
	};
}

function findButtonByText(doc: Document, needle: string): HTMLButtonElement {
	const button = [...doc.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("CourseRetryPanel", () => {
	// plan 013 part 2: A failed chip becomes a button (aria-haspopup="dialog"); other statuses stay plain text
	it("only a failed status chip is a button with aria-haspopup='dialog'; other statuses stay plain text", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/pending.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "pending" },
					{ path: "/course/assigning.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigning" },
					{ path: "/course/assigned.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/failed.pdf", addedAt: "2026-11-22T10:03:00.000Z", via: "learner", binding: true, status: "failed", error: "Read error" },
					{ path: "/course/not-assignable.png", addedAt: "2026-11-22T10:04:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (5)").click();
		});

		const buttons = [...h.doc.querySelectorAll("button")];
		const failedChip = buttons.find((el) => el.textContent?.trim() === "failed");
		assert.ok(failedChip, "Expected failed chip to be a button");
		assert.equal(failedChip.getAttribute("aria-haspopup"), "dialog");

		for (const label of ["waiting", "reading…", "assigned", "not assignable"]) {
			const chipButton = buttons.find((el) => el.textContent?.trim() === label);
			assert.equal(chipButton, undefined, `Expected ${label} status chip not to be a button`);
			assert.ok(h.doc.body.textContent?.includes(label), `Expected ${label} status text to be rendered`);
		}
	});

	// plan 013 part 2: Click opens a popover under the chip with file.error and Retry; Esc or click outside closes it
	it("clicking a failed chip opens a popover with file.error and Retry button, and Esc or outside click closes it", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "PDF is encrypted" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();
		assert.ok(h.doc.body.textContent?.includes("PDF is encrypted"), "Popover shows file.error");
		assert.ok(findButtonByText(h.doc, "Retry"), "Popover shows Retry button");

		// Esc closes the popover
		await act(async () => {
			(h.doc.activeElement ?? h.doc.body).dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await flush();
		assert.equal(h.doc.body.textContent?.includes("PDF is encrypted"), false, "Escape closes the popover");

		// Reopen and click outside to close
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();
		assert.ok(h.doc.body.textContent?.includes("PDF is encrypted"), "Popover reopens on click");

		await act(async () => {
			h.doc.body.dispatchEvent(new h.win.PointerEvent("pointerdown", { bubbles: true }));
		});
		await flush();
		assert.equal(h.doc.body.textContent?.includes("PDF is encrypted"), false, "Click outside closes the popover");
	});

	// plan 013 part 2: Popover shows "Reading failed." when file.error is absent
	it("popover shows 'Reading failed.' when file.error is absent", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		assert.ok(h.doc.body.textContent?.includes("Reading failed."), "Fallback error text is shown");
	});

	// plan 013 part 2: Retry click sends PATCH { path, retry: true }, closes popover, and chip turns "waiting" from course-material-changed refetch
	it("clicking Retry in popover sends PATCH { path, retry: true }, closes popover, and chip turns 'waiting' on refetch", async () => {
		let currentStatus: "failed" | "pending" = "failed";
		const patches: Array<{ url: string; body: unknown }> = [];

		const h = await mountHarness(async (input, init) => {
			const url = String(input);
			if (init?.method === "PATCH") {
				patches.push({ url, body: JSON.parse(String(init.body)) });
				currentStatus = "pending";
				return jsonResponse({ ok: true });
			}
			const data: CourseResponse = {
				material: {
					files: [
						{
							path: "/course/broken.pdf",
							addedAt: "2026-11-22T10:00:00.000Z",
							via: "learner",
							binding: true,
							status: currentStatus,
							...(currentStatus === "failed" ? { error: "Timed out" } : {}),
						},
					],
					methods: [],
					conflicts: [],
				},
				nodes: [{ id: "n1", title: "Linear Maps" }],
			};
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		await act(async () => {
			findButtonByText(h.doc, "Retry").click();
		});
		await flush();

		assert.deepEqual(patches, [{ url: "/api/chats/chat-1/course", body: { path: "/course/broken.pdf", retry: true } }]);
		assert.equal(h.doc.body.textContent?.includes("Timed out"), false, "Popover closes on successful retry");

		await act(async () => {
			h.emitEvent("course-material-changed", { chatId: "chat-1" });
		});
		await flush();

		assert.ok(h.doc.body.textContent?.includes("waiting"), "Chip turns 'waiting' after refetch");
		const waitingBtn = [...h.doc.querySelectorAll("button")].find((el) => el.textContent?.trim() === "waiting");
		assert.equal(waitingBtn, undefined, "Waiting chip is plain text, not a button");
	});

	// plan 013 part 2: On a failed request the popover stays open and shows "Could not retry. Try again."
	it("failed Retry request keeps popover open and shows 'Could not retry. Try again.'", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Timed out" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "PATCH") return jsonResponse({ error: "Server error" }, 500);
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		await act(async () => {
			findButtonByText(h.doc, "Retry").click();
		});
		await flush();

		assert.ok(h.doc.body.textContent?.includes("Timed out"), "Popover stays open");
		assert.ok(h.doc.body.textContent?.includes("Could not retry. Try again."), "Failure message is shown");
	});

	// plan 013 part 2: Unticked file has Retry disabled with tooltip "Tick the file to read it again."
	it("unticked failed file disables Retry with tooltip 'Tick the file to read it again.'", async () => {
		let patchCount = 0;
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: false, status: "failed", error: "Timed out" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "PATCH") {
				patchCount += 1;
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		const retryBtn = findButtonByText(h.doc, "Retry");
		assert.equal(retryBtn.disabled, true, "Retry is disabled when file is unticked");
		assert.equal(retryBtn.getAttribute("title"), "Tick the file to read it again.");
		assert.equal(patchCount, 0);
	});

	// plan 013 part 2: For a failed file, a Retry button before the move buttons, same request and rules; failed files only
	it("details dialog shows Retry before move buttons for failed files only and disables it when unticked", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/failed-ticked.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Corrupt" },
					{ path: "/course/failed-unticked.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: false, status: "failed", error: "Corrupt" },
					{ path: "/course/assigned.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/pending.pdf", addedAt: "2026-11-22T10:03:00.000Z", via: "learner", binding: true, status: "pending" },
					{ path: "/course/assigning.pdf", addedAt: "2026-11-22T10:04:00.000Z", via: "learner", binding: true, status: "assigning" },
					{ path: "/course/notassignable.pdf", addedAt: "2026-11-22T10:05:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (6)").click();
		});

		// Ticked failed file: Retry appears before Move buttons
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for failed-ticked.pdf"]')!.click();
		});
		let dialog = h.doc.querySelector('[role="dialog"]')!;
		const dialogButtons = [...dialog.querySelectorAll("button")].map((b) => b.textContent?.trim());
		const retryIdx = dialogButtons.indexOf("Retry");
		const moveIdx = dialogButtons.findIndex((label) => label?.startsWith("Move to "));
		assert.ok(retryIdx !== -1, "Failed file dialog has Retry button");
		assert.ok(moveIdx !== -1 && retryIdx < moveIdx, "Retry appears before the move buttons");
		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});

		// Unticked failed file: Retry is disabled with tooltip
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for failed-unticked.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		const untickedRetry = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement | undefined;
		assert.ok(untickedRetry, "Unticked failed file dialog still renders Retry button");
		assert.equal(untickedRetry.disabled, true, "Retry is disabled when unticked");
		assert.equal(untickedRetry.getAttribute("title"), "Tick the file to read it again.");
		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});

		// Assigned file: no Retry button
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for assigned.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		const assignedRetry = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
		assert.equal(assignedRetry, undefined, "Assigned file dialog does not have Retry button");
		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});

		// Other non-failed statuses: no Retry button
		for (const name of ["pending.pdf", "assigning.pdf", "notassignable.pdf"]) {
			await act(async () => {
				h.doc.querySelector<HTMLButtonElement>(`[aria-label="Details for ${name}"]`)!.click();
			});
			dialog = h.doc.querySelector('[role="dialog"]')!;
			const other = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
			assert.equal(other, undefined, `${name} dialog does not have Retry button`);
			await act(async () => {
				findButtonByText(h.doc, "Close").click();
			});
		}
	});

	// plan 013 part 2: Dialog Retry uses the same request and rules
	it("details dialog Retry sends PATCH { path, retry: true } and shows 'Could not retry. Try again.' on failure", async () => {
		const patches: Array<{ url: string; body: unknown }> = [];
		let failNext = true;
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Parse error" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (input, init) => {
			const url = String(input);
			if (init?.method === "PATCH") {
				patches.push({ url, body: JSON.parse(String(init.body)) });
				if (failNext) return jsonResponse({ error: "fail" }, 500);
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for broken.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const retryBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement;

		// Failed request keeps dialog open and shows error text
		await act(async () => {
			retryBtn.click();
		});
		await flush();
		assert.ok(h.doc.querySelector('[role="dialog"]'), "Dialog stays open on failed retry");
		assert.ok(dialog.textContent?.includes("Could not retry. Try again."), "Dialog shows retry failure text");

		// Successful request sends PATCH { path, retry: true }
		failNext = false;
		await act(async () => {
			retryBtn.click();
		});
		await flush();

		assert.deepEqual(patches, [
			{ url: "/api/chats/chat-1/course", body: { path: "/course/broken.pdf", retry: true } },
			{ url: "/api/chats/chat-1/course", body: { path: "/course/broken.pdf", retry: true } },
		]);
	});

	it("details dialog clears a previous retry failure message when switching files", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken-1.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Error 1" },
					{ path: "/course/broken-2.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "failed", error: "Error 2" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "PATCH") return jsonResponse({ error: "fail" }, 500);
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for broken-1.pdf"]')!.click();
		});

		const firstDialog = h.doc.querySelector('[role="dialog"]')!;
		const retryBtn = [...firstDialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement;
		await act(async () => {
			retryBtn.click();
		});
		await flush();
		assert.ok(firstDialog.textContent?.includes("Could not retry. Try again."), "First dialog shows retry failure text");

		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for broken-2.pdf"]')!.click();
		});

		const secondDialog = h.doc.querySelector('[role="dialog"]')!;
		assert.equal(secondDialog.textContent?.includes("Could not retry. Try again."), false, "Switching files clears previous retry failure text");
	});

	it("reopening the failed-chip popover clears a retry failure that arrived after closing", async () => {
		let resolvePatch!: (res: Response) => void;
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/broken.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Timed out" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "PATCH") {
				return new Promise<Response>((resolve) => {
					resolvePatch = resolve;
				});
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		await act(async () => {
			findButtonByText(h.doc, "Retry").click();
		});

		await act(async () => {
			(h.doc.activeElement ?? h.doc.body).dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await flush();

		await act(async () => {
			resolvePatch(jsonResponse({ error: "Server error" }, 500));
		});
		await flush();

		await act(async () => {
			findButtonByText(h.doc, "failed").click();
		});
		await flush();

		assert.ok(h.doc.body.textContent?.includes("Timed out"), "Popover reopens");
		assert.equal(h.doc.body.textContent?.includes("Could not retry. Try again."), false, "Reopening clears stale retry failure text");
	});
});
