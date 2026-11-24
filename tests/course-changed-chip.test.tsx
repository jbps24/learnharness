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

async function mountHarness(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = createStorage();
	const navigatorStub = { userAgent: "node-test" };

	Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: storage });
	Object.defineProperty(win, "navigator", { configurable: true, writable: true, value: navigatorStub });

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
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	return { doc };
}

function findButtonByText(doc: Document, needle: string): HTMLButtonElement {
	const button = [...doc.querySelectorAll("button")].find((el) => el.textContent?.includes(needle));
	assert.ok(button, `Expected button containing ${JSON.stringify(needle)}`);
	return button as HTMLButtonElement;
}

describe("SessionCourseFiles — changed chip", () => {
	// plan 015 part 4: a file with changedOnDisk shows a changed chip (button) instead of its status
	it("shows changed chip button instead of status when changedOnDisk is true", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/edited.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned", changedOnDisk: true },
					{ path: "/course/unchanged.pdf", addedAt: "2026-11-24T10:01:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(h.doc, "Files (2)").click();
		});

		const rows = [...h.doc.querySelectorAll("li")];
		assert.equal(rows.length, 2);

		const editedButtons = [...rows[0]!.querySelectorAll("button")];
		const changedChip = editedButtons.find((b) => b.textContent?.trim() === "changed");
		assert.ok(changedChip, "Expected changed chip button on file with changedOnDisk");
		assert.equal(rows[0]!.textContent?.includes("assigned"), false, "Status label is replaced by changed chip");

		const unchangedButtons = [...rows[1]!.querySelectorAll("button")];
		assert.equal(unchangedButtons.find((b) => b.textContent?.trim() === "changed"), undefined);
		assert.equal(rows[1]!.textContent?.includes("assigned"), true, "Normal file still shows its status");
	});

	// plan 015 part 4: changed chip popover says This file changed on disk since it was read. with a button Update, which sends { path, newPath: path }
	it("changed chip popover shows message and Update button sends { path, newPath: path } to replace route", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned", changedOnDisk: true },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const posts: Array<{ url: string; method?: string; body?: unknown }> = [];
		const h = await mountHarness(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/replace")) {
				posts.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});

		const changedChip = findButtonByText(h.doc, "changed");
		await act(async () => {
			changedChip.click();
		});

		const popover = h.doc.querySelector('[role="dialog"]');
		assert.ok(popover, "Expected popover dialog to open");
		assert.ok(popover.textContent?.includes("This file changed on disk since it was read."));

		const updateBtn = [...popover.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update");
		assert.ok(updateBtn, "Expected Update button in popover");

		await act(async () => {
			updateBtn.click();
		});
		await flush();

		assert.equal(posts.length, 1);
		assert.equal(posts[0]!.url, "/api/chats/chat-1/course/replace");
		assert.equal(posts[0]!.method, "POST");
		assert.deepEqual(posts[0]!.body, { path: "/course/notes.pdf", newPath: "/course/notes.pdf" });
	});

	it("closes changed chip popover when Update succeeds", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned", changedOnDisk: true },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/replace")) {
				return jsonResponse({ ok: true });
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "changed").click();
		});

		const popover = h.doc.querySelector('[role="dialog"]');
		assert.ok(popover, "Expected popover dialog to open");
		const updateBtn = [...popover.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update");
		assert.ok(updateBtn, "Expected Update button");

		await act(async () => {
			updateBtn.click();
		});
		await flush();

		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Popover closes after successful Update");
	});

	it("keeps popover open with error on Update failure and clears error when reopened", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned", changedOnDisk: true },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/replace")) {
				return jsonResponse({ error: "Update failed on server." }, 409);
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "changed").click();
		});

		const popover = h.doc.querySelector('[role="dialog"]');
		assert.ok(popover, "Expected popover dialog to open");
		const updateBtn = [...popover.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update");
		assert.ok(updateBtn, "Expected Update button");

		await act(async () => {
			updateBtn.click();
		});
		await flush();

		const openPopover = h.doc.querySelector('[role="dialog"]');
		assert.ok(openPopover, "Popover stays open when Update fails");
		assert.ok(openPopover.textContent?.includes("Update failed on server."));

		await act(async () => {
			findButtonByText(h.doc, "changed").click();
		});
		assert.equal(h.doc.querySelector('[role="dialog"]'), null, "Clicking changed chip closes popover");

		await act(async () => {
			findButtonByText(h.doc, "changed").click();
		});
		const reopened = h.doc.querySelector('[role="dialog"]');
		assert.ok(reopened, "Clicking changed chip reopens popover");
		assert.equal((reopened.textContent ?? "").includes("Update failed on server."), false, "Stale error clears when reopening popover");
	});

	it("shows fallback error and keeps popover open when replace fails without error text", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/notes.pdf", addedAt: "2026-11-24T10:00:00.000Z", via: "learner", binding: true, status: "assigned", changedOnDisk: true },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const h = await mountHarness(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/replace")) {
				return jsonResponse({}, 500);
			}
			return jsonResponse(data);
		});

		await act(async () => {
			findButtonByText(h.doc, "Files (1)").click();
		});
		await act(async () => {
			findButtonByText(h.doc, "changed").click();
		});

		const popover = h.doc.querySelector('[role="dialog"]');
		assert.ok(popover, "Expected popover dialog to open");
		const updateBtn = [...popover.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update");
		assert.ok(updateBtn, "Expected Update button");

		await act(async () => {
			updateBtn.click();
		});
		await flush();

		const openPopover = h.doc.querySelector('[role="dialog"]');
		assert.ok(openPopover, "Popover stays open when replace fails with empty error body");
		assert.ok(openPopover.textContent?.includes("Could not replace the file. Try again."));
	});
});
