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

async function mountDialogHarness(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
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

	const source: NotifySource = {
		close() {},
		onOpen() {},
		onEvent() {},
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

	return { doc };
}

function findButtonByText(root: ParentNode, needle: string): HTMLButtonElement {
	const button = [...root.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("CourseFileDetailsDialog materialKind and book routes", () => {
	// plan 020 part 5: Dialog, material file — button Mark as Overview / Mark as Complete beside move buttons sending Part 1 PATCH
	it("material file dialog shows Mark as Overview or Mark as Complete beside move buttons and sends Part 1 PATCH", async () => {
		const patches: Array<{ url: string; body: unknown }> = [];
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/script.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/exam.pdf", addedAt: "2026-11-25T10:02:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:03:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const { doc } = await mountDialogHarness(async (input, init) => {
			if (init?.method === "PATCH") {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				patches.push({ url, body: JSON.parse(String(init.body)) });
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(doc, "Files (4)").click();
		});

		// Complete material file -> Mark as Overview
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for script.pdf"]')!.click();
		});
		let dialog = doc.querySelector('[role="dialog"]')!;
		const markOverview = findButtonByText(dialog, "Mark as Overview");
		assert.ok(findButtonByText(dialog, "Move to Exams"));
		assert.ok(findButtonByText(dialog, "Move to Reference"));
		await act(async () => {
			markOverview.click();
		});
		await flush();
		assert.deepEqual(patches[0], {
			url: "/api/chats/chat-1/course",
			body: { path: "/course/script.pdf", materialKind: "overview" },
		});
		await act(async () => {
			findButtonByText(dialog, "Close").click();
		});

		// Overview material file -> Mark as Complete
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});
		dialog = doc.querySelector('[role="dialog"]')!;
		const markComplete = findButtonByText(dialog, "Mark as Complete");
		await act(async () => {
			markComplete.click();
		});
		await flush();
		assert.deepEqual(patches[1], {
			url: "/api/chats/chat-1/course",
			body: { path: "/course/slides.pdf", materialKind: "complete" },
		});
		await act(async () => {
			findButtonByText(dialog, "Close").click();
		});

		// Exam and Reference files do not show Mark as Overview / Mark as Complete
		for (const fileName of ["exam.pdf", "book.pdf"]) {
			await act(async () => {
				doc.querySelector<HTMLButtonElement>(`[aria-label="Details for ${fileName}"]`)!.click();
			});
			dialog = doc.querySelector('[role="dialog"]')!;
			const text = dialog.textContent ?? "";
			assert.equal(text.includes("Mark as Overview"), false, `${fileName} does not show Mark as Overview`);
			assert.equal(text.includes("Mark as Complete"), false, `${fileName} does not show Mark as Complete`);
			await act(async () => {
				findButtonByText(dialog, "Close").click();
			});
		}
	});

	// plan 020 part 5: Dialog, material file — Book route (<book file name>, <pages>) with route text, Reading the book…, Book route failed: <error>, nothing when no pointer
	it("Overview material file dialog shows stored book route, Reading the book… for queued/running target, Book route failed: <error>, and nothing without pointer", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/slides.pdf", pages: "Slide 1", method: "Overview route 1" },
					{ nodeId: "n2", path: "/course/slides.pdf", pages: "Slide 2", method: "Overview route 2" },
					{ nodeId: "n3", path: "/course/slides.pdf", pages: "Slide 3", method: "Overview route 3" },
					{ nodeId: "n4", path: "/course/slides.pdf", pages: "Slide 4", method: "Overview route 4" },
				],
				conflicts: [],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
					{ nodeId: "n3", path: "/course/book.pdf", sectionIds: ["s3"] },
				],
				bookRoutes: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 187–190", method: "Book derivation step 1" },
					{ nodeId: "n3", path: "/course/book.pdf", sectionIds: ["s3"], pages: "", method: "", error: "Book read timed out" },
				],
			},
			nodes: [
				{ id: "n1", title: "Stored Node" },
				{ id: "n2", title: "Reading Node" },
				{ id: "n3", title: "Failed Node" },
				{ id: "n4", title: "No Pointer Node" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (2)").click();
		});
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		const items = [...dialog.querySelectorAll("li")];
		const n1 = items.find((li) => li.textContent?.includes("Stored Node"))!;
		const n2 = items.find((li) => li.textContent?.includes("Reading Node"))!;
		const n3 = items.find((li) => li.textContent?.includes("Failed Node"))!;
		const n4 = items.find((li) => li.textContent?.includes("No Pointer Node"))!;

		assert.ok(n1.textContent?.includes("Overview route 1"));
		assert.ok(n1.textContent?.includes("Book route (book.pdf, pp. 187–190)"));
		assert.ok(n1.textContent?.includes("Book derivation step 1"));

		assert.ok(n2.textContent?.includes("Overview route 2"));
		assert.ok(n2.textContent?.includes("Reading the book…"));

		assert.ok(n3.textContent?.includes("Overview route 3"));
		assert.ok(n3.textContent?.includes("Book route failed: Book read timed out"));

		assert.ok(n4.textContent?.includes("Overview route 4"));
		assert.equal(n4.textContent?.includes("Book route"), false);
		assert.equal(n4.textContent?.includes("Reading the book…"), false);
	});

	// plan 020 part 5: book route status under slide routes applies to Overview files only
	it("Complete material file dialog does not show book routes", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/script.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/script.pdf", pages: "p. 1", method: "Complete route 1" },
				],
				conflicts: [],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
				],
				bookRoutes: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10–12", method: "Book route text" },
				],
			},
			nodes: [
				{ id: "n1", title: "Alpha Node" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (2)").click();
		});
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for script.pdf"]')!.click();
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("Complete route 1"));
		assert.equal(text.includes("Book route"), false);
		assert.equal(text.includes("Reading the book…"), false);
	});

	// plan 020 part 5: Dialog, reference file — a node whose book route is stored shows Book route stored after its sections
	it("reference file dialog shows Book route stored after sections only for nodes with a stored book route", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview 1" },
					{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview 2" },
					{ nodeId: "n3", path: "/course/slides.pdf", method: "Overview 3" },
				],
				conflicts: [],
				referenceIndex: [
					{
						path: "/course/book.pdf",
						from: "outline",
						sections: [
							{ id: "s1", title: "Section One", level: 1, startPage: 10, endPage: 15, label: "1.1" },
							{ id: "s2", title: "Section Two", level: 1, startPage: 16, endPage: 20, label: "1.2" },
							{ id: "s3", title: "Section Three", level: 1, startPage: 21, endPage: 25, label: "1.3" },
						],
					},
				],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
					{ nodeId: "n3", path: "/course/book.pdf", sectionIds: ["s3"] },
				],
				bookRoutes: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 10–15", method: "Stored route" },
					{ nodeId: "n3", path: "/course/book.pdf", sectionIds: ["s3"], pages: "", method: "", error: "Failed" },
				],
			},
			nodes: [
				{ id: "n1", title: "Stored Node" },
				{ id: "n2", title: "Pending Node" },
				{ id: "n3", title: "Failed Node" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (2)").click();
		});
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for book.pdf"]')!.click();
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		const items = [...dialog.querySelectorAll("li")];
		const n1 = items.find((li) => li.textContent?.includes("Stored Node"))!;
		const n2 = items.find((li) => li.textContent?.includes("Pending Node"))!;
		const n3 = items.find((li) => li.textContent?.includes("Failed Node"))!;

		const n1Text = n1.textContent ?? "";
		const secIdx = n1Text.indexOf("Section One");
		const storedIdx = n1Text.indexOf("Book route stored");
		assert.ok(secIdx !== -1 && storedIdx > secIdx, "Book route stored appears after sections for stored node");

		assert.equal(n2.textContent?.includes("Book route stored"), false, "Pending node does not show Book route stored");
		assert.equal(n3.textContent?.includes("Book route stored"), false, "Failed node does not show Book route stored");
	});

	it("Overview material file dialog hides book route status when pointer is on unticked reference, sectionIds is empty, or binding Complete file covers node", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/slides2.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/script-binding.pdf", addedAt: "2026-11-25T10:02:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
					{ path: "/course/script-unticked.pdf", addedAt: "2026-11-25T10:03:00.000Z", via: "learner", binding: false, status: "assigned", category: "material", materialKind: "complete" },
					{ path: "/course/book-binding.pdf", addedAt: "2026-11-25T10:04:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
					{ path: "/course/book-unticked.pdf", addedAt: "2026-11-25T10:05:00.000Z", via: "learner", binding: false, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview 1" },
					{ nodeId: "n1", path: "/course/slides2.pdf", method: "Overview 1b" },
					{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview 2" },
					{ nodeId: "n2", path: "/course/script-unticked.pdf", method: "Complete unticked 2" },
					{ nodeId: "n3", path: "/course/slides.pdf", method: "Overview 3" },
					{ nodeId: "n3", path: "/course/script-binding.pdf", method: "Complete binding 3" },
					{ nodeId: "n4", path: "/course/slides.pdf", method: "Overview 4" },
					{ nodeId: "n5", path: "/course/slides.pdf", method: "Overview 5" },
					{ nodeId: "n6", path: "/course/slides.pdf", method: "Overview 6" },
					{ nodeId: "n7", path: "/course/slides.pdf", method: "Overview 7" },
				],
				conflicts: [],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book-binding.pdf", sectionIds: ["s1"] },
					{ nodeId: "n2", path: "/course/book-binding.pdf", sectionIds: ["s2"] },
					{ nodeId: "n3", path: "/course/book-binding.pdf", sectionIds: ["s3"] },
					{ nodeId: "n4", path: "/course/book-unticked.pdf", sectionIds: ["s4"] },
					{ nodeId: "n5", path: "/course/book-unticked.pdf", sectionIds: ["s5"] },
					{ nodeId: "n6", path: "/course/book-unticked.pdf", sectionIds: ["s6"] },
					{ nodeId: "n7", path: "/course/book-binding.pdf", sectionIds: [] },
				],
				bookRoutes: [
					{ nodeId: "n3", path: "/course/book-binding.pdf", sectionIds: ["s3"], pages: "pp. 30–32", method: "Unused book route" },
					{ nodeId: "n5", path: "/course/book-unticked.pdf", sectionIds: ["s5"], pages: "pp. 50–52", method: "Unticked ref route" },
					{ nodeId: "n6", path: "/course/book-unticked.pdf", sectionIds: ["s6"], pages: "", method: "", error: "Unticked ref error" },
				],
			},
			nodes: [
				{ id: "n1", title: "Active With Second Overview" },
				{ id: "n2", title: "Unticked Complete Only" },
				{ id: "n3", title: "Binding Complete Suppresses" },
				{ id: "n4", title: "Unticked Ref Pointer" },
				{ id: "n5", title: "Unticked Ref Stored" },
				{ id: "n6", title: "Unticked Ref Failed" },
				{ id: "n7", title: "Empty Sections Pointer" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (6)").click();
		});
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		const items = [...dialog.querySelectorAll("li")];
		const n1 = items.find((li) => li.textContent?.includes("Active With Second Overview"))!;
		const n2 = items.find((li) => li.textContent?.includes("Unticked Complete Only"))!;
		const n3 = items.find((li) => li.textContent?.includes("Binding Complete Suppresses"))!;
		const n4 = items.find((li) => li.textContent?.includes("Unticked Ref Pointer"))!;
		const n5 = items.find((li) => li.textContent?.includes("Unticked Ref Stored"))!;
		const n6 = items.find((li) => li.textContent?.includes("Unticked Ref Failed"))!;
		const n7 = items.find((li) => li.textContent?.includes("Empty Sections Pointer"))!;

		assert.ok(n1.textContent?.includes("Reading the book…"));
		assert.ok(n2.textContent?.includes("Reading the book…"));

		for (const [label, item] of [
			["Binding Complete Suppresses", n3],
			["Unticked Ref Pointer", n4],
			["Unticked Ref Stored", n5],
			["Unticked Ref Failed", n6],
			["Empty Sections Pointer", n7],
		] as const) {
			assert.equal(item.textContent?.includes("Reading the book…"), false, `${label} does not show Reading the book…`);
			assert.equal(item.textContent?.includes("Book route"), false, `${label} does not show Book route`);
		}
	});

	it("unticked Overview material file dialog does not show Reading the book… or book routes", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: false, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview 1" },
					{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview 2" },
				],
				conflicts: [],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
				],
				bookRoutes: [
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"], pages: "pp. 20–22", method: "Stored route 2" },
				],
			},
			nodes: [
				{ id: "n1", title: "Pending Pointer Node" },
				{ id: "n2", title: "Stored Route Node" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (2)").click();
		});
		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});

		const dialog = doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		assert.equal(text.includes("Reading the book…"), false);
		assert.equal(text.includes("Book route"), false);
	});

	it("treats book routes with error and non-empty method as failed and empty method without error as not stored in both dialogs", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/slides.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/book.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/slides.pdf", method: "Overview 1" },
					{ nodeId: "n2", path: "/course/slides.pdf", method: "Overview 2" },
				],
				conflicts: [],
				referenceIndex: [
					{
						path: "/course/book.pdf",
						from: "outline",
						sections: [
							{ id: "s1", title: "Section One", level: 1, startPage: 1, endPage: 5 },
							{ id: "s2", title: "Section Two", level: 1, startPage: 6, endPage: 10 },
						],
					},
				],
				referencePointers: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"] },
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"] },
				],
				bookRoutes: [
					{ nodeId: "n1", path: "/course/book.pdf", sectionIds: ["s1"], pages: "pp. 1–5", method: "Partial", error: "Partial failure" },
					{ nodeId: "n2", path: "/course/book.pdf", sectionIds: ["s2"], pages: "", method: "" },
				],
			},
			nodes: [
				{ id: "n1", title: "Errored With Method" },
				{ id: "n2", title: "Empty Method No Error" },
			],
		};

		const { doc } = await mountDialogHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (2)").click();
		});

		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for slides.pdf"]')!.click();
		});
		let dialog = doc.querySelector('[role="dialog"]')!;
		let items = [...dialog.querySelectorAll("li")];
		const slideN1 = items.find((li) => li.textContent?.includes("Errored With Method"))!;
		const slideN2 = items.find((li) => li.textContent?.includes("Empty Method No Error"))!;
		assert.ok(slideN1.textContent?.includes("Book route failed: Partial failure"));
		assert.equal(slideN1.textContent?.includes("Partial\n"), false);
		assert.ok(slideN2.textContent?.includes("Reading the book…"));
		assert.equal(slideN2.textContent?.includes("Book route ("), false);
		await act(async () => {
			findButtonByText(dialog, "Close").click();
		});

		await act(async () => {
			doc.querySelector<HTMLButtonElement>('[aria-label="Details for book.pdf"]')!.click();
		});
		dialog = doc.querySelector('[role="dialog"]')!;
		items = [...dialog.querySelectorAll("li")];
		const refN1 = items.find((li) => li.textContent?.includes("Errored With Method"))!;
		const refN2 = items.find((li) => li.textContent?.includes("Empty Method No Error"))!;
		assert.equal(refN1.textContent?.includes("Book route stored"), false);
		assert.equal(refN2.textContent?.includes("Book route stored"), false);
	});
});
