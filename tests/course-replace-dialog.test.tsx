import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { SessionCourseFiles } from "../components/session-course-files.tsx";
import { CourseFileDetailsDialog } from "../components/course-file-details-dialog.tsx";
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

async function mountHarness(options: {
	getPathForFile?: (file: File) => string;
	fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
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

	const bridge = options.getPathForFile ? { getPathForFile: options.getPathForFile } : undefined;
	Object.defineProperty(win, "lh", { configurable: true, writable: true, value: bridge });
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
		fetch: options.fetchImpl,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
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
		for (const [key, descriptor] of legacyInputDescriptors) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return { win, doc };
}

function findButtonByText(doc: Document, needle: string): HTMLButtonElement {
	const button = [...doc.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("CourseFileDetailsDialog — replace", () => {
	// plan 015 part 4: Replace with newer version… button is desktop only (absent without the bridge)
	it("button is absent when desktop bridge is missing", async () => {
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

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for notes.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const replaceBtn = [...dialog.querySelectorAll("button")].find((el) => el.textContent?.includes("Replace with newer version"));
		assert.equal(replaceBtn, undefined, "Replace button should not render without desktop bridge");
	});

	// plan 015 part 4: Replace with newer version… opens file input (accept=".pdf,.md,.markdown,.txt,.tex") and posts { path, newPath } to replace route
	it("Replace with newer version… opens file input with accept and posts picked path to replace route", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/old.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const posts: Array<{ url: string; method?: string; body?: unknown }> = [];
		const h = await mountHarness({
			getPathForFile: () => "/course/new.pdf",
			fetchImpl: async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/replace")) {
					posts.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
					return jsonResponse({ ok: true });
				}
				return jsonResponse(data);
			},
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for old.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const replaceBtn = [...dialog.querySelectorAll("button")].find((el) => el.textContent?.includes("Replace with newer version…"));
		assert.ok(replaceBtn, "Expected Replace with newer version… button");

		const fileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]');
		assert.ok(fileInput, "Expected file input in dialog");
		assert.equal(fileInput.getAttribute("accept"), ".pdf,.md,.markdown,.txt,.tex");

		let inputClicked = false;
		const origClick = fileInput.click.bind(fileInput);
		fileInput.click = () => {
			inputClicked = true;
			origClick();
		};
		await act(async () => {
			replaceBtn.click();
		});
		assert.equal(inputClicked, true, "Clicking Replace with newer version… triggers file input");

		const picked = { name: "new.pdf" } as unknown as File;
		Object.defineProperty(fileInput, "files", { configurable: true, value: [picked] });
		await act(async () => {
			fileInput.dispatchEvent(new h.win.Event("change", { bubbles: true }));
		});
		await flush();

		assert.equal(posts.length, 1);
		assert.equal(posts[0]!.url, "/api/chats/chat-1/course/replace");
		assert.equal(posts[0]!.method, "POST");
		assert.deepEqual(posts[0]!.body, { path: "/course/old.pdf", newPath: "/course/new.pdf" });
	});

	// plan 015 part 4: errors from the replace route are shown under the button
	it("shows route errors under the Replace with newer version… button", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/old.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness({
			getPathForFile: () => "/course/existing.pdf",
			fetchImpl: async (input) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/replace")) {
					return jsonResponse({ error: "existing.pdf is already in the list." }, 409);
				}
				return jsonResponse(data);
			},
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for old.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const fileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]');
		assert.ok(fileInput, "Expected file input in dialog");
		Object.defineProperty(fileInput, "files", { configurable: true, value: [{ name: "existing.pdf" }] });
		await act(async () => {
			fileInput.dispatchEvent(new h.win.Event("change", { bubbles: true }));
		});
		await flush();

		const text = dialog.textContent ?? "";
		assert.ok(text.includes("existing.pdf is already in the list."), "Shows error from replace route");
		const btnIdx = text.indexOf("Replace with newer version…");
		const errIdx = text.indexOf("existing.pdf is already in the list.");
		assert.ok(btnIdx !== -1 && errIdx > btnIdx, "Error appears under/after the button");
	});

	// plan 015 part 4: while the replace read runs, dialog shows Comparing with the earlier version…
	it("shows Comparing with the earlier version… while replace read is running", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{
						path: "/course/new.pdf",
						addedAt: "2026-11-24T10:00:00.000Z",
						via: "learner",
						binding: true,
						status: "assigning",
						update: {
							at: "2026-11-24T12:00:00.000Z",
							fromPath: "/course/old.pdf",
							previous: [{ nodeId: "n1", method: "Old route" }],
							revisited: [],
							planAsked: false,
						},
					},
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Node One" }],
		};

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for new.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Comparing with the earlier version…"));
	});

	// plan 015 part 4: change list shows Replaced <old file name> on <date>., groups Changed route, Newly covered, No longer covered, Sections outside the plan, and pointed out for revisited changed nodes
	it("shows Replaced <old file name> on <date>., change list groups, and pointed out for revisited changed nodes", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{
						path: "/course/v2.pdf",
						addedAt: "2026-11-24T10:00:00.000Z",
						via: "learner",
						binding: true,
						status: "assigned",
						update: {
							at: "2026-11-24T12:00:00.000Z",
							fromPath: "/course/v1.pdf",
							previous: [
								{ nodeId: "n1", method: "Old 1" },
								{ nodeId: "n2", method: "Old 2" },
								{ nodeId: "n4", method: "Old 4" },
								{ nodeId: "n5", method: "Old 5" },
							],
							nodes: [
								{ nodeId: "n1", kind: "changed" },
								{ nodeId: "n2", kind: "changed" },
								{ nodeId: "n3", kind: "new" },
								{ nodeId: "n4", kind: "dropped" },
								{ nodeId: "n5", kind: "same" },
							],
							newSections: [
								{ title: "Appendix A", pages: "pp. 40–45" },
							],
							revisited: ["n1"],
							planAsked: false,
						},
					},
				],
				methods: [
					{ nodeId: "n1", path: "/course/v2.pdf", method: "New 1" },
					{ nodeId: "n2", path: "/course/v2.pdf", method: "New 2" },
					{ nodeId: "n3", path: "/course/v2.pdf", method: "New 3" },
					{ nodeId: "n5", path: "/course/v2.pdf", method: "Old 5" },
				],
				conflicts: [],
			},
			nodes: [
				{ id: "n1", title: "Revisited Changed Node" },
				{ id: "n2", title: "Pending Changed Node" },
				{ id: "n3", title: "Newly Covered Node" },
				{ id: "n4", title: "Dropped Node" },
				{ id: "n5", title: "Unchanged Node" },
			],
		};

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for v2.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";

		assert.match(text, /Replaced v1\.pdf on .+\./);

		const changedIdx = text.indexOf("Changed route");
		const newlyIdx = text.indexOf("Newly covered");
		const droppedIdx = text.indexOf("No longer covered");
		const outsideIdx = text.indexOf("Sections outside the plan");
		assert.ok(changedIdx !== -1, "Expected Changed route group");
		assert.ok(newlyIdx > changedIdx, "Expected Newly covered group after Changed route");
		assert.ok(droppedIdx > newlyIdx, "Expected No longer covered group after Newly covered");
		assert.ok(outsideIdx > droppedIdx, "Expected Sections outside the plan group after No longer covered");

		const revisitedIdx = text.indexOf("Revisited Changed Node");
		const pendingIdx = text.indexOf("Pending Changed Node");
		assert.ok(revisitedIdx > changedIdx && revisitedIdx < newlyIdx, "Revisited changed node is in Changed route");
		assert.ok(pendingIdx > changedIdx && pendingIdx < newlyIdx, "Pending changed node is in Changed route");

		const revisitedLi = [...dialog.querySelectorAll("li")].find((li) => li.textContent?.includes("Revisited Changed Node"));
		const pendingLi = [...dialog.querySelectorAll("li")].find((li) => li.textContent?.includes("Pending Changed Node"));
		assert.ok(revisitedLi?.textContent?.includes("pointed out"), "Changed node in revisited gets pointed out");
		assert.equal(pendingLi?.textContent?.includes("pointed out") ?? false, false, "Changed node not in revisited does not get pointed out");

		const newNodeIdx = text.indexOf("Newly Covered Node");
		assert.ok(newNodeIdx > newlyIdx && newNodeIdx < droppedIdx, "New node is in Newly covered");

		const droppedNodeIdx = text.indexOf("Dropped Node");
		assert.ok(droppedNodeIdx > droppedIdx && droppedNodeIdx < outsideIdx, "Dropped node is in No longer covered");

		assert.ok(text.includes("Appendix A", outsideIdx), "Section title appears under Sections outside the plan");
		assert.ok(text.includes("pp. 40–45", outsideIdx), "Section pages appear under Sections outside the plan");
	});

	it("omits Replace with newer version… button when onReplace is not provided even with desktop bridge", async () => {
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

		Object.defineProperty(win, "lh", { configurable: true, writable: true, value: { getPathForFile: () => "/course/new.pdf" } });
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

		const file = { path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner" as const, binding: true, status: "assigned" as const };
		await act(async () => {
			root.render(
				<InteractionLayersProvider>
					<CourseFileDetailsDialog
						file={file}
						material={{ files: [file], methods: [], conflicts: [] }}
						nodes={[]}
						lessonNodes={[]}
						onClose={() => {}}
					/>
				</InteractionLayersProvider>,
			);
		});
		await flush();

		const dialog = doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected details dialog");
		const replaceBtn = [...dialog.querySelectorAll("button")].find((el) => el.textContent?.includes("Replace with newer version"));
		assert.equal(replaceBtn, undefined, "Replace button should not render without onReplace");
	});

	it("does not render empty update group headings", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{
						path: "/course/v2.pdf",
						addedAt: "2026-11-24T10:00:00.000Z",
						via: "learner",
						binding: true,
						status: "assigned",
						update: {
							at: "2026-11-24T12:00:00.000Z",
							fromPath: "/course/v1.pdf",
							previous: [{ nodeId: "n1", method: "Old 1" }],
							nodes: [{ nodeId: "n1", kind: "same" }],
							newSections: [],
							revisited: [],
							planAsked: false,
						},
					},
				],
				methods: [{ nodeId: "n1", path: "/course/v2.pdf", method: "Old 1" }],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Unchanged Node" }],
		};

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for v2.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		assert.match(text, /Replaced v1\.pdf on .+\./);
		assert.equal(text.includes("Changed route"), false, "Empty Changed route group should not render");
		assert.equal(text.includes("Newly covered"), false, "Empty Newly covered group should not render");
		assert.equal(text.includes("No longer covered"), false, "Empty No longer covered group should not render");
		assert.equal(text.includes("Sections outside the plan"), false, "Empty Sections outside the plan group should not render");
	});

	it("clears replace error when switching to a different file", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/first.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/second.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness({
			getPathForFile: () => "/course/bad.pdf",
			fetchImpl: async (input) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/replace")) {
					return jsonResponse({ error: "Cannot replace with bad.pdf." }, 400);
				}
				return jsonResponse(data);
			},
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for first.pdf"]')!.click();
		});

		const firstDialog = h.doc.querySelector('[role="dialog"]')!;
		const fileInput = firstDialog.querySelector<HTMLInputElement>('input[type="file"]');
		assert.ok(fileInput, "Expected file input in dialog");
		Object.defineProperty(fileInput, "files", { configurable: true, value: [{ name: "bad.pdf" }] });
		await act(async () => {
			fileInput.dispatchEvent(new h.win.Event("change", { bubbles: true }));
		});
		await flush();
		assert.ok(firstDialog.textContent?.includes("Cannot replace with bad.pdf."));

		const closeBtn = [...firstDialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close");
		assert.ok(closeBtn, "Expected Close button");
		await act(async () => {
			closeBtn.click();
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null);

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for second.pdf"]')!.click();
		});
		const secondDialog = h.doc.querySelector('[role="dialog"]')!;
		assert.equal((secondDialog.textContent ?? "").includes("Cannot replace with bad.pdf."), false, "Replace error clears on file switch");
	});

});
