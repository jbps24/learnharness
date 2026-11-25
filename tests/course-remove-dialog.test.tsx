import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
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
	const legacyInputDescriptors = new Map(["attachEvent", "detachEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
	Object.assign(prototype, { attachEvent() {}, detachEvent() {} });
	prototype.setAttribute = function (name: string, value: string) { originalSetAttribute.call(this, name.toLowerCase(), value); };
	let focusCalls = 0;
	prototype.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		if (++focusCalls > 100) throw new Error("fixture focus recursion");
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

	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
	Object.assign(win, { getComputedStyle: style, innerWidth: 1200 });

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
		Node: win.Node,
		HTMLInputElement: win.HTMLInputElement,
		Event: win.Event,
		MouseEvent: win.MouseEvent,
		CustomEvent: win.CustomEvent,
		MutationObserver: win.MutationObserver,
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		getComputedStyle: style,
		localStorage: storage,
		navigator: navigatorStub,
		fetch: fetchImpl,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	const container = doc.getElementById("root")!;
	const root = createRoot(container);
	let controller!: InteractionLayersController;
	function Probe() {
		controller = useInteractionLayers();
		return null;
	}

	await act(async () => {
		root.render(
			<InteractionLayersProvider>
				<Probe />
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
		controller: () => controller,
		emitEvent(name: string, payload: unknown) {
			const raw = JSON.stringify(payload);
			for (const cb of listeners.get(name) ?? []) cb(raw);
		},
	};
}

function findButtonByText(root: ParentNode, needle: string): HTMLButtonElement {
	const button = [...root.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

function findButtonByExactText(root: ParentNode, exact: string): HTMLButtonElement {
	const button = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === exact);
	assert.ok(button, `Expected button with exact text ${JSON.stringify(exact)}`);
	return button as HTMLButtonElement;
}

describe("CourseFileDetailsDialog remove", () => {
	// plan 014 part 2: Remove from list button is present for every file status and appears before the move buttons
	it("shows Remove from list before the move buttons for every file status", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/wait.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "pending" },
					{ path: "/course/reading.md", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigning" },
					{ path: "/course/done.pdf", addedAt: "2026-11-24T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/broken.tex", addedAt: "2026-11-24T10:03:00.000Z", via: "learner", binding: true, status: "failed", error: "Read failed" },
					{ path: "/course/img.png", addedAt: "2026-11-24T10:04:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (5)").click();
		});

		for (const name of ["wait.pdf", "reading.md", "done.pdf", "broken.tex", "img.png"]) {
			await act(async () => {
				h.doc.querySelector<HTMLButtonElement>(`[aria-label="Details for ${name}"]`)!.click();
			});
			const dialog = h.doc.querySelector('[role="dialog"]')!;
			const buttons = [...dialog.querySelectorAll("button")];
			const removeIdx = buttons.findIndex((b) => b.textContent?.trim() === "Remove from list");
			const firstMoveIdx = buttons.findIndex((b) => b.textContent?.trim().startsWith("Move to "));
			assert.notEqual(removeIdx, -1, `${name}: expected Remove from list button`);
			assert.notEqual(firstMoveIdx, -1, `${name}: expected move buttons`);
			assert.ok(removeIdx < firstMoveIdx, `${name}: Remove from list appears before move buttons`);

			await act(async () => {
				findButtonByExactText(dialog, "Close").click();
			});
		}
	});

	// plan 014 part 2: Clicking Remove from list replaces the button row with the confirmation text and Remove / Cancel buttons; Cancel restores the button row
	it("replaces the button row with the confirmation on click and restores it on Cancel", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/sub/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for notes.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});

		const confirmText = "Remove notes.pdf? What was read from it is removed too. The file itself stays on your disk.";
		assert.ok(dialog.textContent?.includes(confirmText), "Shows confirmation text with file name");
		assert.ok(findButtonByExactText(dialog, "Remove"), "Shows Remove button");
		assert.ok(findButtonByExactText(dialog, "Cancel"), "Shows Cancel button");
		assert.equal(dialog.querySelectorAll("button").length, 2, "Replaces the button row with only Remove and Cancel");

		await act(async () => {
			findButtonByExactText(dialog, "Cancel").click();
		});

		assert.equal(dialog.textContent?.includes(confirmText), false, "Hides confirmation text on Cancel");
		assert.ok(findButtonByExactText(dialog, "Remove from list"), "Restores Remove from list button");
		assert.ok(findButtonByText(dialog, "Move to "), "Restores move buttons");
		assert.ok(findButtonByExactText(dialog, "Close"), "Restores Close button");
	});

	// plan 014 part 2: Remove sends DELETE with { path }, closes the dialog on success, refetches on course-material-changed, and hides Files (n) when the last file is removed
	it("sends DELETE with { path }, closes on success, refetches on course-material-changed, and hides Files (n) when empty", async () => {
		let payload: CourseResponse = {
			material: {
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/b.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		const requests: Array<{ url: string; method: string; body?: string }> = [];

		const h = await mountHarness(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? "GET";
			requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
			if (method === "DELETE") return jsonResponse({ ok: true });
			return jsonResponse(payload);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for a.pdf"]')!.click();
		});

		let dialog = h.doc.querySelector('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});

		const delCalls = requests.filter((r) => r.method === "DELETE");
		assert.equal(delCalls.length, 1);
		assert.equal(delCalls[0]!.url, "/api/chats/chat-1/course");
		assert.deepEqual(JSON.parse(delCalls[0]!.body ?? "{}"), { path: "/course/a.pdf" });
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Dialog closes on DELETE success");

		payload = {
			material: {
				files: [
					{ path: "/course/b.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		assert.ok(findButtonByText(h.doc, "Files (1)"), "Panel refetches on course-material-changed");

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for b.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null);

		payload = {
			material: { files: [], methods: [], conflicts: [] },
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		assert.equal(h.doc.querySelector('[data-testid="session-course-files"]'), null, "Files (n) row hides when last file is removed");
	});

	// plan 014 part 2: On DELETE failure the confirmation stays and shows Could not remove the file. Try again.
	it("keeps the confirmation open and shows failure text when DELETE fails, then closes if retry succeeds", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/fail.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		let deleteCalls = 0;

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "DELETE") {
				deleteCalls++;
				if (deleteCalls === 1) return jsonResponse({ error: "boom" }, 500);
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for fail.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});

		assert.ok(h.doc.querySelector('[role="dialog"]'), "Dialog stays open on failure");
		assert.ok(dialog.textContent?.includes("Remove fail.pdf? What was read from it is removed too. The file itself stays on your disk."));
		assert.ok(dialog.textContent?.includes("Could not remove the file. Try again."));
		assert.ok(findButtonByExactText(dialog, "Remove"));
		assert.ok(findButtonByExactText(dialog, "Cancel"));

		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Dialog closes when subsequent DELETE succeeds");
	});

	// plan 014 part 2: Switching the dialog to another file clears the confirmation, the remove failure, and the retry failure
	it("clears the confirmation, remove failure, and retry failure when switching to another file", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/one.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "failed", error: "Err 1" },
					{ path: "/course/two.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "failed", error: "Err 2" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "PATCH" || init?.method === "DELETE") {
				return jsonResponse({ error: "fail" }, 500);
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for one.pdf"]')!.click();
		});

		let dialog = h.doc.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Retry").click();
		});
		assert.ok(dialog.textContent?.includes("Could not retry. Try again."));

		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});
		assert.ok(dialog.textContent?.includes("Could not remove the file. Try again."));

		const escEvent = new h.win.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escEvent, { key: "Escape" });
		await act(async () => {
			h.controller().captureKeyDown(escEvent as unknown as KeyboardEvent);
			dialog.dispatchEvent(escEvent);
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null);

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for two.pdf"]')!.click();
		});
		dialog = h.doc.querySelector<HTMLElement>('[role="dialog"]')!;
		assert.ok(findButtonByExactText(dialog, "Remove from list"), "Confirmation is cleared for the next file");
		assert.equal(dialog.textContent?.includes("Could not remove the file. Try again."), false, "Remove failure is cleared for the next file");
		assert.equal(dialog.textContent?.includes("Could not retry. Try again."), false, "Retry failure is cleared for the next file");
	});
});

describe("CourseFileDetailsDialog remove edge cases", () => {
	it("clears remove failure when switching to another file even after reopening confirmation", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/one.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/two.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "DELETE") return jsonResponse({ error: "fail" }, 500);
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for one.pdf"]')!.click();
		});

		let dialog = h.doc.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});
		assert.ok(dialog.textContent?.includes("Could not remove the file. Try again."));

		const escEvent = new h.win.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escEvent, { key: "Escape" });
		await act(async () => {
			h.controller().captureKeyDown(escEvent as unknown as KeyboardEvent);
			dialog.dispatchEvent(escEvent);
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null);

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for two.pdf"]')!.click();
		});
		dialog = h.doc.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		assert.ok(findButtonByExactText(dialog, "Remove"), "Confirmation opens for two.pdf");
		assert.equal(dialog.textContent?.includes("Could not remove the file. Try again."), false, "Stale remove failure does not reappear on two.pdf");
	});

	it("clears remove failure on Cancel before reopening confirmation", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (_input, init) => {
			if (init?.method === "DELETE") return jsonResponse({ error: "fail" }, 500);
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for notes.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove").click();
		});
		assert.ok(dialog.textContent?.includes("Could not remove the file. Try again."));

		await act(async () => {
			findButtonByExactText(dialog, "Cancel").click();
		});
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		assert.ok(findButtonByExactText(dialog, "Remove"));
		assert.equal(dialog.textContent?.includes("Could not remove the file. Try again."), false, "Reopened confirmation does not show stale remove error");
	});

	it("hides the confirmation panel when onRemove is removed across re-renders", async () => {
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
		let focusCalls = 0;
		prototype.focus = function () {
			if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
			if (++focusCalls > 100) throw new Error("fixture focus recursion");
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

		Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });
		Object.assign(win, { getComputedStyle: style, innerWidth: 1200 });

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
			NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
			getComputedStyle: style,
			navigator: navigatorStub,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		const saved = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries(globals)) {
			saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}

		const container = doc.getElementById("root")!;
		const root = createRoot(container);
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

		const { CourseFileDetailsDialog } = await import("../components/course-file-details-dialog.tsx");
		const file = {
			path: "/course/notes.pdf",
			addedAt: "2026-11-24T10:00:00.000Z",
			via: "learner" as const,
			binding: true,
			status: "assigned" as const,
		};
		const material: CourseMaterial = { files: [file], methods: [], conflicts: [] };

		await act(async () => {
			root.render(
				<InteractionLayersProvider>
					<CourseFileDetailsDialog
						file={file}
						material={material}
						nodes={[]}
						lessonNodes={[]}
						onClose={() => {}}
						onRemove={async () => true}
					/>
				</InteractionLayersProvider>,
			);
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		await act(async () => {
			findButtonByExactText(dialog, "Remove from list").click();
		});
		assert.ok(findButtonByExactText(dialog, "Remove"), "Confirmation opens while onRemove is present");

		await act(async () => {
			root.render(
				<InteractionLayersProvider>
					<CourseFileDetailsDialog
						file={file}
						material={material}
						nodes={[]}
						lessonNodes={[]}
						onClose={() => {}}
					/>
				</InteractionLayersProvider>,
			);
		});

		const updatedDialog = doc.querySelector('[role="dialog"]')!;
		assert.equal(updatedDialog.textContent?.includes("What was read from it is removed too."), false, "Confirmation closes when onRemove is removed");
		assert.ok(findButtonByExactText(updatedDialog, "Close"), "Normal button row is shown without onRemove");
	});
});
