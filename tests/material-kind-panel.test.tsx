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

async function mountPanel(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window;
	const doc = dom.document;
	const storage = createStorage();
	const navigatorStub = { userAgent: "node-test" };

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

describe("SessionCourseFiles materialKind chips", () => {
	// plan 020 part 5: in the "Course material" group, an assigned file shows a chip Complete or Overview after its status chip
	it("shows Complete or Overview chip after status chip for assigned files in Course material group", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/1-script.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "complete" },
					{ path: "/course/2-slides.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "material", materialKind: "overview" },
					{ path: "/course/3-default.pdf", addedAt: "2026-11-25T10:02:00.000Z", via: "learner", binding: true, status: "assigned" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const { doc } = await mountPanel(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (3)").click();
		});

		const rows = [...doc.querySelectorAll("li")];
		assert.equal(rows.length, 3);

		for (const [index, expectedKind] of [[0, "Complete"], [1, "Overview"], [2, "Complete"]] as const) {
			const row = rows[index]!;
			const text = row.textContent ?? "";
			const statusIdx = text.indexOf("assigned");
			const kindIdx = text.indexOf(expectedKind);
			assert.ok(statusIdx !== -1, `Row ${index} shows assigned status`);
			assert.ok(kindIdx > statusIdx, `Row ${index} shows ${expectedKind} after status chip`);
			const chip = [...row.querySelectorAll("span")].find((el) => el.textContent?.trim() === expectedKind);
			assert.ok(chip, `Row ${index} renders ${expectedKind} chip`);
		}
	});

	// plan 020 part 5: only assigned files in the "Course material" group show Complete or Overview
	it("does not show Complete or Overview for non-assigned material files or for exam and reference files", async () => {
		const data: CourseResponse = {
			material: {
				files: [
					{ path: "/course/1-pending.pdf", addedAt: "2026-11-25T10:00:00.000Z", via: "learner", binding: true, status: "pending", category: "material" },
					{ path: "/course/2-assigning.pdf", addedAt: "2026-11-25T10:01:00.000Z", via: "learner", binding: true, status: "assigning", category: "material" },
					{ path: "/course/3-failed.pdf", addedAt: "2026-11-25T10:02:00.000Z", via: "learner", binding: true, status: "failed", error: "Read failed", category: "material" },
					{ path: "/course/4-other.png", addedAt: "2026-11-25T10:03:00.000Z", via: "learner", binding: true, status: "not-assignable", category: "material" },
					{ path: "/course/5-exam.pdf", addedAt: "2026-11-25T10:04:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
					{ path: "/course/6-book.pdf", addedAt: "2026-11-25T10:05:00.000Z", via: "learner", binding: true, status: "assigned", category: "reference" },
				],
				methods: [],
				conflicts: [],
			},
			nodes: [],
		};

		const { doc } = await mountPanel(async () => jsonResponse(data));
		await act(async () => {
			findButtonByText(doc, "Files (6)").click();
		});

		const rows = [...doc.querySelectorAll("li")];
		assert.equal(rows.length, 6);
		for (const row of rows) {
			const text = row.textContent ?? "";
			assert.equal(text.includes("Complete"), false, `Unexpected Complete chip in ${text}`);
			assert.equal(text.includes("Overview"), false, `Unexpected Overview chip in ${text}`);
		}
	});
});
