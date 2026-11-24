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

describe("ReferenceFilesPanel", () => {
	// plan 012 part 5: Third group Reference after "Exams" (hidden when empty)
	it("shows Reference group third after Course material and Exams", async () => {
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

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (3)").click();
		});

		const panel = h.doc.querySelector('[data-testid="session-course-files"]')!;
		const text = panel.textContent ?? "";
		const materialIdx = text.indexOf("Course material");
		const examsIdx = text.indexOf("Exams");
		const refIdx = text.indexOf("Reference");
		assert.ok(materialIdx !== -1 && examsIdx !== -1 && refIdx !== -1, "All three group headings are shown");
		assert.ok(materialIdx < examsIdx && examsIdx < refIdx, "Reference appears after Course material and Exams");
		assert.ok(text.includes("textbook.pdf"));
	});

	// plan 012 part 5: Third group Reference after "Exams" (hidden when empty)
	it("hides Reference group when no reference files exist", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" },
					{ path: "/exams/ws2024.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});

		const panel = h.doc.querySelector('[data-testid="session-course-files"]')!;
		const text = panel.textContent ?? "";
		assert.ok(text.includes("Course material"));
		assert.ok(text.includes("Exams"));
		assert.equal(text.includes("Reference"), false, "Reference group is hidden when empty");
	});

	// plan 012 part 5: Dialog for a reference file: per node (map order) the pointed sections §6.2 Optimal Prediction… (pp. 205–210); a line "Table of contents: N sections (from outline|contents|headings)"
	it("reference file details dialog lists pointed sections per node in map order and TOC summary", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/ref/textbook.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
					{ path: "/ref/other.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
				referenceIndex: [
					{
						path: "/ref/textbook.pdf",
						from: "outline",
						sections: [
							{ id: "s1", label: "3.1", title: "Vector Spaces", level: 2, startPage: 80, endPage: 92 },
							{ id: "s2", label: "6.2", title: "Optimal Prediction", level: 2, startPage: 205, endPage: 210 },
							{ id: "s3", label: "6.3", title: "Kalman Filter", level: 2, startPage: 211, endPage: 220 },
						],
					},
					{
						path: "/ref/other.pdf",
						from: "contents",
						sections: [
							{ id: "o1", label: "1.1", title: "Other Book Section", level: 2, startPage: 10, endPage: 15 },
						],
					},
				],
				referencePointers: [
					{ nodeId: "n3", path: "/ref/textbook.pdf", sectionIds: ["s2", "s3"] },
					{ nodeId: "n_missing", path: "/ref/textbook.pdf", sectionIds: ["s1"] },
					{ nodeId: "n1", path: "/ref/textbook.pdf", sectionIds: ["s1"] },
					{ nodeId: "n1", path: "/ref/other.pdf", sectionIds: ["o1"] },
				],
			},
			nodes: [
				{ id: "n1", title: "Linear Algebra" },
				{ id: "n2", title: "Eigenvalues" },
				{ id: "n3", title: "Estimation" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for textbook.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected dialog to open");
		const text = dialog.textContent ?? "";

		assert.equal(text.includes("Eigenvalues"), false, "Unused node omitted");
		assert.equal(text.includes("Other Book Section"), false, "Other file's section omitted");

		const laIdx = text.indexOf("Linear Algebra");
		const estIdx = text.indexOf("Estimation");
		assert.ok(laIdx !== -1 && estIdx !== -1 && laIdx < estIdx, "Nodes appear in plan-map order");

		assert.ok(text.includes("§3.1 Vector Spaces (pp. 80–92)"));
		assert.ok(text.includes("§6.2 Optimal Prediction (pp. 205–210)"));
		assert.ok(text.includes("§6.3 Kalman Filter (pp. 211–220)"));
		assert.ok(text.includes("Table of contents: 3 sections (from outline)"));
	});

	// plan 012 part 5: a line "Table of contents: N sections (from outline|contents|headings)"
	it("reference file details dialog shows TOC line with source when no nodes point to it", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/ref/notes.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
				referenceIndex: [
					{
						path: "/ref/notes.pdf",
						from: "headings",
						sections: [
							{ id: "s1", label: "1", title: "Introduction", level: 1, startPage: 1, endPage: 10 },
							{ id: "s2", label: "2", title: "Background", level: 1, startPage: 11, endPage: 25 },
						],
					},
				],
				referencePointers: [],
			},
			nodes: [{ id: "n1", title: "Linear Algebra" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for notes.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected dialog to open");
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("Table of contents: 2 sections (from headings)"));
	});

	// plan 012 part 5: a line "Table of contents: N sections (from outline|contents|headings)"
	it("reference file details dialog shows TOC line with source 'contents'", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/ref/other.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
				referenceIndex: [
					{
						path: "/ref/other.pdf",
						from: "contents",
						sections: [
							{ id: "o1", label: "1.1", title: "Other Book Section", level: 2, startPage: 10, endPage: 15 },
						],
					},
				],
				referencePointers: [],
			},
			nodes: [{ id: "n1", title: "Linear Algebra" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for other.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected dialog to open");
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("Table of contents: 1 sections (from contents)"));
	});

	it("lists unticked reference files greyed out in the Reference group", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/ref/unbound.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: false, status: "assigned", category: "reference" },
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

		const panel = h.doc.querySelector('[data-testid="session-course-files"]')!;
		const text = panel.textContent ?? "";
		assert.ok(text.includes("Reference"), "Reference group heading is shown");
		assert.ok(text.includes("unbound.pdf"), "Unticked reference file is listed");
		const item = panel.querySelector("li");
		assert.ok(item?.className.includes("opacity-50"), "Unticked reference file is greyed out");
		const checkbox = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
		assert.equal(checkbox?.checked, false);
	});

	it("orders reference files by addedAt in the Reference group", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/ref/newer.pdf", addedAt: "2026-11-22T10:05:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
					{ path: "/ref/older.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [{ id: "n1", title: "Linear Maps" }],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});

		const panel = h.doc.querySelector('[data-testid="session-course-files"]')!;
		const text = panel.textContent ?? "";
		const olderIdx = text.indexOf("older.pdf");
		const newerIdx = text.indexOf("newer.pdf");
		assert.ok(olderIdx !== -1 && newerIdx !== -1, "Both reference files are listed");
		assert.ok(olderIdx < newerIdx, "Reference files are ordered by addedAt");
	});
});
