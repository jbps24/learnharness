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

function findButtonByText(doc: Document, needle: string): HTMLButtonElement {
	const button = [...doc.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("CourseFileDetailsDialog", () => {
	// plan 009 part 2: Dialog header, status line, inherited label, no extra fetch, and closing via Close button, Esc, or click outside
	it("opens on ⓘ without extra fetch, shows header, path, status, inherited label, and closes via Close button, Esc, and backdrop click", async () => {
		let fetches = 0;
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/sub/notes.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "inherited", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => {
			fetches++;
			return jsonResponse(data);
		});
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		assert.equal(fetches, 1);

		const infoBtn = h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for notes.pdf"]');
		assert.ok(infoBtn, "Expected ⓘ button");

		await act(async () => {
			infoBtn.click();
		});
		assert.equal(fetches, 1, "Opening dialog performs no extra fetch");

		const dialog = h.doc.querySelector('[role="dialog"]');
		assert.ok(dialog, "Expected dialog to open");
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("notes.pdf"), "Shows file name heading");
		assert.ok(text.includes("/course/sub/notes.pdf"), "Shows full path");
		assert.ok(text.includes("Status: assigned"), "Shows status line");
		assert.ok(text.includes("from lesson"), "Shows inherited label");

		// Close via Close button
		const closeBtn = [...dialog.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Close");
		assert.ok(closeBtn, "Expected Close button");
		await act(async () => {
			closeBtn.click();
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Close button closes dialog");

		// Reopen and close via Escape
		await act(async () => {
			infoBtn.click();
		});
		const reopenedForEsc = h.doc.querySelector<HTMLElement>('[role="dialog"]');
		assert.ok(reopenedForEsc);
		const escEvent = new h.win.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escEvent, { key: "Escape" });
		await act(async () => {
			h.controller().captureKeyDown(escEvent as unknown as KeyboardEvent);
			reopenedForEsc.dispatchEvent(escEvent);
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Escape closes dialog");

		// Reopen and close via backdrop click
		await act(async () => {
			infoBtn.click();
		});
		const reopenedForBackdrop = h.doc.querySelector<HTMLElement>('[role="dialog"]');
		assert.ok(reopenedForBackdrop);
		const backdrop = reopenedForBackdrop.firstElementChild?.firstElementChild as HTMLElement | null;
		assert.ok(backdrop, "Expected HostDialog backdrop element");
		const pointerDown = new h.win.Event("pointerdown", { bubbles: true, cancelable: true });
		Object.assign(pointerDown, { isPrimary: true, button: 0, pointerId: 1 });
		const pointerUp = new h.win.Event("pointerup", { bubbles: true, cancelable: true });
		Object.assign(pointerUp, { isPrimary: true, button: 0, pointerId: 1 });
		const click = new h.win.Event("click", { bubbles: true, cancelable: true });
		Object.assign(click, { button: 0 });
		await act(async () => {
			backdrop.dispatchEvent(pointerDown);
			backdrop.dispatchEvent(pointerUp);
			backdrop.dispatchEvent(click);
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Click outside closes dialog");
	});

	// plan 009 part 2: Assigned teaching file shows Used for 2 plan nodes:, blocks in plan-map order with pages, whitespace-pre-wrap method text, and ⚠ on unresolved conflict including this file
	it("assigned teaching file lists nodes in plan-map order with pages, line-broken method text, plural count, and ⚠ on conflicted node", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n3", path: "/course/a.pdf", pages: "S. 20–27", method: "Line 1\nLine 2" },
					{ nodeId: "n_missing", path: "/course/a.pdf", method: "Should be ignored" },
					{ nodeId: "n1", path: "/course/a.pdf", method: "Route A1" },
					{ nodeId: "n4", path: "/course/a.pdf", method: "Route A4" },
				],
				conflicts: [
					{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] },
					{ nodeId: "n4", paths: ["/course/b.pdf", "/course/c.pdf"] },
					{ nodeId: "n3", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/a.pdf" },
				],
			},
			nodes: [
				{ id: "n1", title: "Alpha Node" },
				{ id: "n2", title: "Beta Node" },
				{ id: "n3", title: "Gamma Node" },
				{ id: "n4", title: "Delta Node" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for a.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("Used for 3 plan nodes:"), "Shows plural node count");
		assert.equal(text.includes("Beta Node"), false);
		assert.equal(text.includes("Should be ignored"), false);

		const alphaIdx = text.indexOf("Alpha Node");
		const gammaIdx = text.indexOf("Gamma Node");
		assert.ok(alphaIdx !== -1 && gammaIdx !== -1 && alphaIdx < gammaIdx, "Blocks appear in plan-map order");
		assert.ok(text.includes("S. 20–27"), "Shows pages when present");
		assert.ok(text.includes("Line 1\nLine 2"), "Keeps line breaks in method text");
		assert.ok(dialog.querySelector(".whitespace-pre-wrap"), "Method text uses whitespace-pre-wrap");

		const conflictMarks = [...dialog.querySelectorAll("[title]")].filter(
			(el) => el.getAttribute("title") === "Your tutor will ask which route your course uses.",
		);
		assert.equal(conflictMarks.length, 1, "Only the unresolved conflict that includes this file (n1) shows warning");
		assert.ok(conflictMarks[0]!.textContent?.includes("⚠"));
	});

	// plan 009 part 2: Singular Used for 1 plan node: and Not used for any plan node. for assigned file with no methods
	it("singular Used for 1 plan node: and empty assigned Not used for any plan node.", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/one.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
					{ path: "/course/none.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/one.pdf", method: "Single route" },
				],
				conflicts: [],
			},
			nodes: [
				{ id: "n1", title: "Only Node" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});

		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for one.pdf"]')!.click();
		});
		let dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Used for 1 plan node:"), "Singular count");
		assert.ok(dialog.textContent?.includes("Only Node"));

		await act(async () => {
			findButtonByText(h.doc, "Close").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for none.pdf"]')!.click();
		});
		dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Not used for any plan node."), "Empty assigned message");
	});

	// plan 009 part 2: Non-assigned statuses show Status: <label>, error for failed, and No plan nodes yet.
	it("non-assigned statuses show status label, failed error, and No plan nodes yet.", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/wait.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "pending" },
					{ path: "/course/reading.md", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigning" },
					{ path: "/course/broken.tex", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "failed", error: "Could not read TeX" },
					{ path: "/course/img.png", addedAt: "2026-11-22T10:03:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (4)").click();
		});

		for (const [name, statusLabel, extra] of [
			["wait.pdf", "Status: waiting", "/course/wait.pdf"],
			["reading.md", "Status: reading…", "/course/reading.md"],
			["broken.tex", "Status: failed", "Could not read TeX"],
			["img.png", "Status: not assignable", "/course/img.png"],
		] as const) {
			await act(async () => {
				h.doc.querySelector<HTMLButtonElement>(`[aria-label="Details for ${name}"]`)!.click();
			});
			const dialog = h.doc.querySelector('[role="dialog"]')!;
			const text = dialog.textContent ?? "";
			assert.ok(text.includes(statusLabel), `${name} shows ${statusLabel}`);
			assert.ok(text.includes(extra), `${name} shows ${extra}`);
			assert.ok(text.includes("No plan nodes yet."), `${name} shows No plan nodes yet.`);
			await act(async () => {
				findButtonByText(h.doc, "Close").click();
			});
		}
	});

	// plan 009 part 2: Practice session titles blocks from lessonNodes, merges identical lesson+node+method blocks, and falls back to From the lesson
	it("practice session titles blocks from lessonNodes, merges identical lesson+node+method blocks, and falls back to From the lesson", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/prac.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "inherited", binding: true, status: "assigned" },
{ path: "/course/other.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "inherited", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
				propositionMethods: [
					{ propositionId: "p1", lessonId: "L1", nodeId: "n1", path: "/course/prac.pdf", pages: "pp. 1-3", method: "Same method" },
					{ propositionId: "p2", lessonId: "L1", nodeId: "n1", path: "/course/prac.pdf", pages: "pp. 1-3", method: "Same method" },
					{ propositionId: "p3", lessonId: "L2", nodeId: "n9", path: "/course/prac.pdf", method: "Fallback method" },
{ propositionId: "p4", lessonId: "L1", nodeId: "n1", path: "/course/prac.pdf", method: "Different method" },
{ propositionId: "p5", lessonId: "L1", nodeId: "n1", path: "/course/other.pdf", method: "Other file method" },
				],
			},
			nodes: [],
			lessonNodes: [
				{ lessonId: "L1", id: "n1", title: "Lesson Alpha" },
{ lessonId: "L1", id: "n9", title: "Other lesson" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for prac.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		assert.ok(text.includes("Used for 3 plan nodes:"), "Same-method duplicates merge; other method and fallback stay separate");
		assert.equal(text.match(/Lesson Alpha/g)?.length, 2, "Same lesson+node with a different method is its own block");
		assert.ok(text.includes("Different method"));
		assert.equal(text.includes("Other file method"), false, "Methods of another file are not shown");
		assert.equal(text.includes("Other lesson"), false, "(L2, n9) does not match (L1, n9)");
		assert.equal(text.match(/Same method/g)?.length, 1, "Merged method text appears once");
		assert.ok(text.includes("pp. 1-3"));
		assert.ok(text.includes("From the lesson"), "Missing lessonNode falls back to From the lesson");
		assert.ok(text.includes("Fallback method"));
	});

	// plan 009 part 2: course-material-changed refresh updates open dialog for the same path and closes if the path is gone
	it("course-material-changed updates open dialog for the same path and closes it when the path is gone", async () => {
		let payload: CourseResponse = {
			material: {
				files: [
					{ path: "/course/live.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "pending" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [
				{ id: "n1", title: "Live Node" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(payload));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for live.pdf"]')!.click();
		});

		let dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog.textContent?.includes("Status: waiting"));
		assert.ok(dialog.textContent?.includes("No plan nodes yet."));

		// Refresh with updated status & method
		payload = {
			material: {
				files: [
					{ path: "/course/live.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/live.pdf", method: "Updated method" },
				],
				conflicts: [],
			},
			nodes: [
				{ id: "n1", title: "Live Node" },
			],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		dialog = h.doc.querySelector('[role="dialog"]')!;
		assert.ok(dialog, "Dialog stays open while path still exists");
		assert.ok(dialog.textContent?.includes("Status: assigned"));
		assert.ok(dialog.textContent?.includes("Used for 1 plan node:"));
		assert.ok(dialog.textContent?.includes("Live Node"));
		assert.ok(dialog.textContent?.includes("Updated method"));

		// Refresh with path removed
		payload = {
			material: {
				files: [
					{ path: "/course/other.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();

		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Dialog closes when the file path is gone");
	});

	// plan 009 part 2: Dialog marks ⚠ specifically on the unresolved-conflict node and not on the resolved-conflict node
	it("marks ⚠ on the unresolved-conflict node block and not on the resolved-conflict node block", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/a.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [
					{ nodeId: "n1", path: "/course/a.pdf", method: "Route A1" },
					{ nodeId: "n3", path: "/course/a.pdf", method: "Route A3" },
				],
				conflicts: [
					{ nodeId: "n1", paths: ["/course/a.pdf", "/course/b.pdf"] },
					{ nodeId: "n3", paths: ["/course/a.pdf", "/course/b.pdf"], chosen: "/course/a.pdf" },
				],
			},
			nodes: [
				{ id: "n1", title: "Alpha Node" },
				{ id: "n3", title: "Gamma Node" },
			],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for a.pdf"]')!.click();
		});

		const dialog = h.doc.querySelector('[role="dialog"]')!;
		const items = [...dialog.querySelectorAll("li")];
		const alphaItem = items.find((li) => li.textContent?.includes("Alpha Node"));
		const gammaItem = items.find((li) => li.textContent?.includes("Gamma Node"));
		assert.ok(alphaItem && gammaItem, "Expected both node blocks");
		assert.ok(alphaItem.querySelector('[title="Your tutor will ask which route your course uses."]')?.textContent?.includes("⚠"));
		assert.equal(gammaItem.querySelector('[title="Your tutor will ask which route your course uses."]'), null);
		assert.equal(gammaItem.textContent?.includes("⚠"), false);
	});

	// plan 009 part 2: Closing via file removal clears detailsPath so re-adding the same path does not reopen the dialog
	it("does not reopen the dialog when a removed file is re-added in the same session", async () => {
		let payload: CourseResponse = {
			material: {
				files: [
					{ path: "/course/readd.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => jsonResponse(payload));
		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			h.doc.querySelector<HTMLButtonElement>('[aria-label="Details for readd.pdf"]')!.click();
		});
		assert.ok(h.doc.querySelector('[role="dialog"]'));

		payload = {
			material: {
				files: [
					{ path: "/course/other.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();
		assert.equal(h.doc.querySelector('[role="dialog"]'), null);

		payload = {
			material: {
				files: [
					{ path: "/course/readd.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};
		h.emitEvent("course-material-changed", { chatId: "chat-1" });
		await flush();
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Dialog stays closed when removed path is re-added");
	});
});
