import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { SessionCourseFiles } from "../components/session-course-files.tsx";
import type { CourseMaterial } from "../src/core/contracts/course.ts";

interface CourseResponse {
	material: CourseMaterial | null;
	nodes: Array<{ id: string; title: string }>;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

function createStorage(throwing = false): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear() {
			if (throwing) throw new Error("storage disabled");
			map.clear();
		},
		getItem(key: string) {
			if (throwing) throw new Error("storage disabled");
			return map.get(key) ?? null;
		},
		key(index: number) {
			return [...map.keys()][index] ?? null;
		},
		removeItem(key: string) {
			if (throwing) throw new Error("storage disabled");
			map.delete(key);
		},
		setItem(key: string, value: string) {
			if (throwing) throw new Error("storage disabled");
			map.set(key, value);
		},
	};
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function mountHarness(options: {
	chatId?: string;
	active?: boolean;
	openCourseFile?: (chatId: string, path: string) => Promise<void>;
	storage?: Storage;
	fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = options.storage ?? createStorage();
	const clipboardWrites: string[] = [];
	const navigatorStub = {
		userAgent: "node-test",
		clipboard: {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		},
	};

	const listeners = new Map<string, Array<(data: string) => void>>();
	let openHandler: (() => void) | null = null;
	const source: NotifySource = {
		close() {},
		onOpen(cb) { openHandler = cb; },
		onEvent(name, cb) {
			const list = listeners.get(name) ?? [];
			list.push(cb);
			listeners.set(name, list);
		},
	};

	const bridge = options.openCourseFile ? { openCourseFile: options.openCourseFile } : undefined;
	Object.defineProperty(win, "lh", { configurable: true, writable: true, value: bridge });
	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });

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
	let currentChatId = options.chatId ?? "chat-1";
	let currentActive = options.active ?? true;

	const render = async (chatId = currentChatId, active = currentActive) => {
		currentChatId = chatId;
		currentActive = active;
		await act(async () => {
			root.render(
				<ServerEventsProvider connect={() => source}>
					<SessionCourseFiles chatId={currentChatId} active={currentActive} />
				</ServerEventsProvider>,
			);
		});
		await flush();
	};

	await render();

	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return {
		doc,
		container,
		clipboardWrites,
		storage,
		render,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
		},
		emitEvent(name: string, payload: unknown) {
			const raw = JSON.stringify(payload);
			for (const cb of listeners.get(name) ?? []) cb(raw);
		},
		triggerResync() {
			openHandler?.();
		},
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function findButtonByText(doc: Document, needle: string): HTMLButtonElement {
	const button = [...doc.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("SessionCourseFiles", () => {
	// plan 007 part 7: Nothing renders for inactive rows
	it("inactive session renders no dropdown and does not fetch", async () => {
		let fetches = 0;
		const h = await mountHarness({
			active: false,
			fetchImpl: async () => {
				fetches++;
				return jsonResponse({ material: null, nodes: [] });
			},
		});
		assert.equal(fetches, 0);
		assert.equal(h.container.textContent?.trim(), "");
	});

	// plan 007 part 7: Header row "Files (n)" is hidden when n is 0
	it("header row Files (n) is hidden when n is 0 or material is null", async () => {
		let payload: CourseResponse = { material: null, nodes: [] };
		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(payload),
		});
		assert.equal(h.container.textContent?.includes("Files ("), false);

		payload = { material: { files: [], methods: [], conflicts: [] }, nodes: [] };
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();
		assert.equal(h.container.textContent?.includes("Files ("), false);
	});

	// plan 007 part 7: Collapsed by default; open state remembered per session in localStorage wrapped in try/catch
	it("collapsed by default, opens on click, and remembers open state per session in localStorage resiliently", async () => {
		const storage = createStorage();
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h1 = await mountHarness({
			chatId: "chat-a",
			storage,
			fetchImpl: async () => jsonResponse(data),
		});
		const toggle = findButtonByText(h1.doc, "Files (1)");
		assert.equal(h1.container.textContent?.includes("notes.pdf"), false, "collapsed by default");

		await act(async () => {
			toggle.click();
		});
		assert.equal(h1.container.textContent?.includes("notes.pdf"), true, "expanded after click");
		await cleanup?.();
		cleanup = undefined;
		cleanup = cleanup as (() => Promise<void>) | undefined;

		// Remount same session: stays expanded
		const h2 = await mountHarness({
			chatId: "chat-a",
			storage,
			fetchImpl: async () => jsonResponse(data),
		});
		assert.equal(h2.container.textContent?.includes("notes.pdf"), true, "remembers open state for chat-a");
		await cleanup?.();
		cleanup = undefined;
		cleanup = cleanup as (() => Promise<void>) | undefined;

		// Different session: starts collapsed
		const h3 = await mountHarness({
			chatId: "chat-b",
			storage,
			fetchImpl: async () => jsonResponse(data),
		});
		assert.equal(h3.container.textContent?.includes("notes.pdf"), false, "chat-b stays collapsed");
		await cleanup?.();
		cleanup = undefined;

		// Throwing localStorage does not break rendering or toggling
		const h4 = await mountHarness({
			chatId: "chat-c",
			storage: createStorage(true),
			fetchImpl: async () => jsonResponse(data),
		});
		const toggle4 = findButtonByText(h4.doc, "Files (1)");
		await act(async () => {
			toggle4.click();
		});
		assert.equal(h4.container.textContent?.includes("notes.pdf"), true);
	});

	// plan 007 part 7: Each file row in addedAt order with filePathLabel, path tooltip, status chips, error tooltip, and "from lesson" for inherited files
	it("renders files in addedAt order with label, path tooltip, status chips, failed error tooltip, and inherited label", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/5-image.png", addedAt: "2026-11-22T10:05:00.000Z", via: "learner", binding: true, status: "not-assignable" },
					{ path: "/course/2-tutor.md", addedAt: "2026-11-22T10:02:00.000Z", via: "tutor", binding: true, status: "assigning" },
					{ path: "/course/1-first.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "pending" },
					{ path: "/course/4-broken.tex", addedAt: "2026-11-22T10:04:00.000Z", via: "learner", binding: true, status: "failed", error: "Could not read TeX" },
					{ path: "/course/3-inherited.pdf", addedAt: "2026-11-22T10:03:00.000Z", via: "inherited", binding: true, status: "assigned" },
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
			findButtonByText(h.doc, "Files (5)").click();
		});

		const text = h.container.textContent ?? "";
		const expectedOrder = ["1-first.pdf", "2-tutor.md", "3-inherited.pdf", "4-broken.tex", "5-image.png"];
		let lastIndex = -1;
		for (const name of expectedOrder) {
			const idx = text.indexOf(name);
			assert.ok(idx > lastIndex, `Expected ${name} after index ${lastIndex}, got ${idx}`);
			lastIndex = idx;
		}

		for (const label of ["waiting", "reading…", "assigned", "failed", "not assignable"]) {
			assert.ok(text.includes(label), `Missing status chip ${label}`);
		}

		const fromLessonMatches = text.match(/from lesson/g) ?? [];
		assert.equal(fromLessonMatches.length, 1, "Only inherited file gets 'from lesson'");

		const pathTooltipEl = [...h.doc.querySelectorAll("[title]")].find((el) => el.getAttribute("title") === "/course/1-first.pdf");
		assert.ok(pathTooltipEl, "File row/name has full path as tooltip");

		const failedTooltipEl = [...h.doc.querySelectorAll("[title]")].find(
			(el) => el.textContent?.includes("failed") && el.getAttribute("title") === "Could not read TeX",
		);
		assert.ok(failedTooltipEl, "Failed chip carries error tooltip");
	});

	// plan 009 part 2: Row renders no node titles, renders the ⓘ button (aria-label "Details for <file name>", data-testid="course-file-details"), and marks ⚠ iff an unresolved conflict of one of the file's nodes includes the file
	it("renders no node titles in the row, renders the info button with aria-label, and marks unresolved conflicts involving the file", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/b.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n3", path: "/course/a.pdf", method: "Route A3" },
					{ nodeId: "n1", path: "/course/a.pdf", method: "Route A1" },
					{ nodeId: "n1", path: "/course/b.pdf", method: "Route B1" },
					{ nodeId: "n2", path: "/course/b.pdf", method: "Route B2" },
				],
				conflicts: [
					{ nodeId: "n1", paths: ["/course/a.pdf", "/course/other.pdf"] },
					{ nodeId: "n3", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/a.pdf" },
				],
			},
			nodes: [
				{ id: "n1", title: "Alpha Node" },
				{ id: "n2", title: "Beta Node" },
				{ id: "n3", title: "Gamma Node" },
			],
		};

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});

		const text = h.container.textContent ?? "";
		assert.equal(text.includes("Alpha Node"), false, "Row must not render node titles");
		assert.equal(text.includes("Beta Node"), false, "Row must not render node titles");
		assert.equal(text.includes("Gamma Node"), false, "Row must not render node titles");

		const detailButtons = [...h.doc.querySelectorAll('[data-testid="course-file-details"]')];
		assert.equal(detailButtons.length, 2, "Each row renders an info button");
		assert.equal(detailButtons[0]!.getAttribute("aria-label"), "Details for a.pdf");
		assert.equal(detailButtons[1]!.getAttribute("aria-label"), "Details for b.pdf");

		const rows = [...h.doc.querySelectorAll("li")];
		assert.equal(rows.length, 2);
		const rowAMarks = [...rows[0]!.querySelectorAll("[title]")].filter(
			(el) => el.getAttribute("title") === "Your tutor will ask which route your course uses.",
		);
		const rowBMarks = [...rows[1]!.querySelectorAll("[title]")].filter(
			(el) => el.getAttribute("title") === "Your tutor will ask which route your course uses.",
		);
		assert.equal(rowAMarks.length, 1, "Unresolved conflict including a.pdf marks a.pdf row");
		assert.ok(rowAMarks[0]!.textContent?.includes("⚠"));
		const order = [...rows[0]!.querySelectorAll("*")];
		const checkboxAt = order.findIndex((el) => el.tagName === "INPUT");
		const nameAt = order.findIndex((el) => el.tagName === "BUTTON" && el.textContent?.trim() === "a.pdf");
		const chipAt = order.findIndex((el) => el.tagName !== "BUTTON" && el.children.length === 0 && el.textContent?.trim() === "assigned");
		const markAt = order.indexOf(rowAMarks[0]!);
		const infoAt = order.indexOf(detailButtons[0]!);
		assert.ok(checkboxAt >= 0 && nameAt > checkboxAt, "Name button follows the checkbox");
		assert.ok(chipAt > nameAt, "Status chip follows the name button");
		assert.ok(markAt > chipAt, "⚠ follows the status chip");
		assert.ok(infoAt > markAt, "ⓘ button comes last, after ⚠");
		assert.equal(rowBMarks.length, 0, "Resolved conflict and conflict not listing b.pdf do not mark b.pdf row");
	});

	// plan 007 part 7: Checkbox calls PATCH /api/chats/:id/course optimistically and reverts on failure
	it("ticking calls PATCH optimistically and reverts checkbox on failure", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		const patches: Array<{ url: string; body: unknown }> = [];
		let resolvePatch!: (res: Response) => void;

		const h = await mountHarness({
			chatId: "chat-patch",
			fetchImpl: async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (init?.method === "PATCH") {
					patches.push({ url, body: JSON.parse(String(init.body)) });
					return new Promise<Response>((resolve) => {
						resolvePatch = resolve;
					});
				}
				return jsonResponse(data);
			},
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});

		const checkbox = h.doc.querySelector<HTMLInputElement>('input[type="checkbox"]');
		assert.ok(checkbox, "Expected checkbox");
		assert.equal(checkbox.checked, true);

		// First toggle: optimistic uncheck, then PATCH succeeds
		await act(async () => {
			checkbox.click();
		});
		assert.equal(checkbox.checked, false, "optimistically unchecked");
		assert.deepEqual(patches[0], {
			url: "/api/chats/chat-patch/course",
			body: { path: "/course/notes.pdf", binding: false },
		});
		await act(async () => {
			resolvePatch(jsonResponse({ ok: true }));
		});
		await flush();
		assert.equal(checkbox.checked, false, "stays unchecked after success");

		// Second toggle: optimistic check, then PATCH fails -> reverts
		await act(async () => {
			checkbox.click();
		});
		assert.equal(checkbox.checked, true, "optimistically checked");
		await act(async () => {
			resolvePatch(jsonResponse({ error: "Server error" }, 500));
		});
		await flush();
		assert.equal(checkbox.checked, false, "reverted after PATCH failure");
	});

	// plan 007 part 7: Click calls window.lh.openCourseFile when present, otherwise copies the path
	it("clicking a file opens it via window.lh.openCourseFile when present, or copies the path without the bridge", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/lecture.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		const opened: Array<[string, string]> = [];

		// With Electron bridge
		const hWithBridge = await mountHarness({
			chatId: "chat-open",
			openCourseFile: async (chatId, path) => {
				opened.push([chatId, path]);
			},
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(hWithBridge.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(hWithBridge.doc, "lecture.pdf").click();
		});
		assert.deepEqual(opened, [["chat-open", "/course/lecture.pdf"]]);
		assert.deepEqual(hWithBridge.clipboardWrites, []);
		await cleanup?.();
		cleanup = undefined;

		// Without Electron bridge
		const hNoBridge = await mountHarness({
			chatId: "chat-open",
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(hNoBridge.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(hNoBridge.doc, "lecture.pdf").click();
		});
		assert.deepEqual(hNoBridge.clipboardWrites, ["/course/lecture.pdf"]);
	});

	// plan 007 part 7: Refetches on course-material-changed for this chat and on server resync
	it("refetches on course-material-changed for this chat and on server resync", async () => {
		let fetches = 0;
		let response: CourseResponse = {
			material: {
				files: [
					{ path: "/course/one.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "pending" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness({
			chatId: "chat-1",
			fetchImpl: async () => {
				fetches++;
				return jsonResponse(response);
			},
		});
		assert.equal(fetches, 1);
		assert.ok(h.container.textContent?.includes("Files (1)"));

		// Event for another chat is ignored
		h.emitEvent("course-material-changed", { chatId: "chat-other" });
		await flush();
		assert.equal(fetches, 1);

		// Event for this chat refetches
		response = {
			material: {
				files: [
					...response.material!.files,
					{ path: "/course/two.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "tutor", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();
		assert.equal(fetches, 2);
		assert.ok(h.container.textContent?.includes("Files (2)"));

		// Server resync refetches
		h.triggerResync();
		await flush();
		assert.equal(fetches, 3);
	});

	// plan 009 part 2: Conflict mark requires unresolved conflict, matching nodeId, and method on the same file
	it("marks ⚠ only when an unresolved conflict includes the file and the file has a method for that node", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/only-conflicted.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/resolved-only.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/no-method.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/only-conflicted.pdf", method: "Route 1" },
					{ nodeId: "n2", path: "/course/resolved-only.pdf", method: "Route 2" },
					{ nodeId: "n2", path: "/course/no-method.pdf", method: "Route 2b" },
				],
				conflicts: [
					{ nodeId: "n1", paths: ["/course/only-conflicted.pdf", "/course/no-method.pdf"] },
					{ nodeId: "n2", paths: ["/course/resolved-only.pdf", "/course/other.pdf"], chosen: "/course/resolved-only.pdf" },
				],
			},
			nodes: [
				{ id: "n1", title: "Node One" },
				{ id: "n2", title: "Node Two" },
			],
		};

		const h = await mountHarness({
			fetchImpl: async () => jsonResponse(data),
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (3)").click();
		});

		const rows = [...h.doc.querySelectorAll("li")];
		assert.equal(rows.length, 3);
		const tip = "Your tutor will ask which route your course uses.";
		const hasMark = (row: Element) => row.querySelector(`[title="${tip}"]`) !== null;
		assert.equal(hasMark(rows[0]!), true, "Unresolved conflict with matching node method shows ⚠");
		assert.equal(hasMark(rows[1]!), false, "Resolved conflict does not show ⚠");
		assert.equal(hasMark(rows[2]!), false, "Conflict for another node without this file's method on that node does not show ⚠");
	});

	// plan 007 part 7: Unticked rows are dimmed with opacity-50 while ticked rows are not
	it("dims unticked rows with opacity-50 and leaves ticked rows undimmed", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/ticked.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/unticked.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: false, status: "assigned" },
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
			findButtonByText(h.doc, "Files (2)").click();
		});

		const rows = [...h.doc.querySelectorAll("li")];
		assert.equal(rows.length, 2);
		assert.equal((rows[0]!.getAttribute("class") ?? "").split(/\s+/).includes("opacity-50"), false, "Ticked row is not dimmed");
		assert.equal((rows[1]!.getAttribute("class") ?? "").split(/\s+/).includes("opacity-50"), true, "Unticked row is dimmed with opacity-50");
	});
});
