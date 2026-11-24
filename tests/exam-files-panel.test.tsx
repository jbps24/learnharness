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

	return {
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

describe("ExamFilesPanel", () => {
	// plan 010 part 4: For an exam file the dialog lists, per node in plan-map order, the node title and one block per pattern: source, pages, the pattern text and, when present, Grading: and the grading text
	it("exam file details dialog lists patterns per node in plan-map order with source, pages, pattern, and optional Grading:", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/exams/ws2024.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
				],
				methods: [],
				conflicts: [],
				examPatterns: [
					{
						nodeId: "n3",
						path: "/exams/ws2024.pdf",
						source: "Aufgabe 3",
						pages: "S. 4",
						pattern: "Prove compactness from sequential compactness.",
						grading: "2 pts for subsequence, 3 pts for contradiction.",
					},
					{
						nodeId: "n_missing",
						path: "/exams/ws2024.pdf",
						source: "Aufgabe 9",
						pattern: "Ignored unknown node pattern.",
					},
					{
						nodeId: "n1",
						path: "/exams/ws2024.pdf",
						source: "Aufgabe 1a",
						pattern: "Compute the determinant of a 3x3 matrix.",
					},
					{
						nodeId: "n1",
						path: "/exams/ws2024.pdf",
						source: "Aufgabe 1b",
						pages: "S. 2",
						pattern: "Determine parameter values for invertibility.",
					},
					{
						nodeId: "n1",
						path: "/exams/other.pdf",
						source: "Aufgabe 7 other",
						pattern: "Pattern from another exam file.",
					},
				],
			},
			nodes: [
				{ id: "n1", title: "Determinants" },
				{ id: "n2", title: "Eigenvalues" },
				{ id: "n3", title: "Compactness" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for ws2024.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected dialog to open");
		const text = dialog.textContent ?? "";

		assert.equal(text.includes("Eigenvalues"), false, "Unused node omitted");
		assert.equal(text.includes("Ignored unknown node pattern."), false, "Unknown node omitted");
		// plan 010 part 4: the dialog lists only the selected file's patterns
		assert.equal(text.includes("Pattern from another exam file."), false, "Other file's pattern omitted");

		const detIdx = text.indexOf("Determinants");
		const compIdx = text.indexOf("Compactness");
		assert.ok(detIdx !== -1 && compIdx !== -1 && detIdx < compIdx, "Nodes appear in plan-map order");

		assert.ok(text.includes("Aufgabe 1a"));
		assert.ok(text.includes("Compute the determinant of a 3x3 matrix."));
		assert.ok(text.includes("Aufgabe 1b"));
		assert.ok(text.includes("S. 2"));
		assert.ok(text.includes("Determine parameter values for invertibility."));
		assert.ok(text.includes("Aufgabe 3"));
		assert.ok(text.includes("S. 4"));
		assert.ok(text.includes("Prove compactness from sequential compactness."));
		assert.ok(text.includes("Grading:"));
		assert.ok(text.includes("2 pts for subsequence, 3 pts for contradiction."));
		assert.equal(text.match(/Grading:/g)?.length, 1, "Grading: only appears when grading text is present");
	});

	// plan 010 part 4: Move to Exams / Move to Course material button sends PATCH and dialog shows new status while re-read
	it("move button sends category PATCH and dialog updates status while re-reading", async () => {
		const patches: Array<{ url: string; body: unknown }> = [];
		let payload: CourseResponse = {
			material: {
				files: [
					{ path: "/course/sheet.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/sheet.pdf", method: "Standard route" },
				],
				conflicts: [],
			},
			nodes: [
				{ id: "n1", title: "Linear Maps" },
			],
		};

		const h = await mountHarness(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PATCH") {
				patches.push({ url, body: JSON.parse(String(init.body)) });
				return jsonResponse({ ok: true });
			}
			return jsonResponse(payload);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for sheet.pdf"]')!.click();
		});

		const moveToExamsBtn = findButtonByText(h.doc, "Move to Exams");
		await act(async () => {
			moveToExamsBtn.click();
		});
		assert.deepEqual(patches[0], {
			url: "/api/chats/chat-1/course",
			body: { path: "/course/sheet.pdf", category: "exam" },
		});

		// Re-read begins: pending -> assigning -> assigned
		payload = {
			material: {
				files: [
					{ path: "/course/sheet.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "pending", category: "exam", categoryBy: "learner" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		let dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Status: waiting"));
		assert.ok(dialog.textContent?.includes("Move to Course material"));

		payload = {
			material: {
				files: [
					{ path: "/course/sheet.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigning", category: "exam", categoryBy: "learner" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Status: reading…"));

		const moveToMaterialBtn = findButtonByText(h.doc, "Move to Course material");
		await act(async () => {
			moveToMaterialBtn.click();
		});
		assert.deepEqual(patches[1], {
			url: "/api/chats/chat-1/course",
			body: { path: "/course/sheet.pdf", category: "material" },
		});
	});

	// plan 012 part 5: Move buttons: one per other category — Move to Course material, Move to Exams, Move to Reference
	it("move buttons show one per other category for material, exam, and reference files", async () => {
		const patches: Array<{ url: string; body: unknown }> = [];
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" },
					{ path: "/exams/ws2024.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
					{ path: "/ref/textbook.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PATCH") {
				patches.push({ url, body: JSON.parse(String(init.body)) });
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (3)").click();
		});

		// Course material file: Move to Exams + Move to Reference
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});
		let dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.equal(dialog.textContent?.includes("Move to Course material"), false);
		assert.ok(dialog.textContent?.includes("Move to Exams"));
		const moveToRefBtn = findButtonByText(h.doc, "Move to Reference");
		await act(async () => {
			moveToRefBtn.click();
		});
		assert.deepEqual(patches[0], {
			url: "/api/chats/chat-1/course",
			body: { path: "/course/slides.pdf", category: "reference" },
		});
		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});

		// Exam file: Move to Course material + Move to Reference
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for ws2024.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Move to Course material"));
		assert.equal(dialog.textContent?.includes("Move to Exams"), false);
		assert.ok(dialog.textContent?.includes("Move to Reference"));
		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});

		// Reference file: Move to Course material + Move to Exams
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for textbook.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Move to Course material"));
		assert.ok(dialog.textContent?.includes("Move to Exams"));
		assert.equal(dialog.textContent?.includes("Move to Reference"), false);
	});
});
