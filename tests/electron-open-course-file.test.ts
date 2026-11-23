import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainPath = require.resolve("../electron/main.cjs");

type OpenCourseFileHandler = (event: unknown, chatId: unknown, filePath: unknown) => Promise<void>;

async function loadOpenCourseFileHandler(getListedFiles: (chatId: string) => string[] | null) {
	const userDataDir = mkdtempSync(path.join(tmpdir(), "lh-electron-course-"));
	const openedPaths: string[] = [];

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		const match = /^\/api\/chats\/([^/]+)\/course$/.exec(url);
		if (match) {
			const files = getListedFiles(decodeURIComponent(match[1]!));
			if (files === null) {
				res.writeHead(404, { "content-type": "application/json", connection: "close" });
				res.end(JSON.stringify({ error: "Not found" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({
				material: {
					files: files.map((filePath) => ({ path: filePath })),
					methods: [],
					conflicts: [],
				},
			}));
			return;
		}
		res.writeHead(200, { "content-type": "application/json", connection: "close" });
		res.end(JSON.stringify({ ok: true }));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let lastWindow: MockBrowserWindow | null = null;
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

	class MockBrowserWindow {
		webContents: {
			mainFrame: { url: string };
			on: () => void;
			once: () => void;
			setWindowOpenHandler: () => void;
			send: () => void;
			getZoomFactor: () => number;
			isLoadingMainFrame: () => boolean;
		};

		constructor() {
			this.webContents = {
				mainFrame: { url: `${origin}/chat/chat-1` },
				on: () => {},
				once: () => {},
				setWindowOpenHandler: () => {},
				send: () => {},
				getZoomFactor: () => 1,
				isLoadingMainFrame: () => false,
			};
			lastWindow = this;
			if (handlers.has("lh:open-course-file")) resolveReady();
		}

		once() {}
		loadURL() { return Promise.resolve(); }
		isDestroyed() { return false; }
		show() {}
		setBackgroundColor() {}
		setTitleBarOverlay() {}

		static getAllWindows() { return lastWindow ? [lastWindow] : []; }
		static fromWebContents(sender: unknown) {
			return lastWindow && sender === lastWindow.webContents ? lastWindow : null;
		}
	}

	const electronStub = {
		app: {
			isPackaged: false,
			name: "LearnHarness",
			setName: () => {},
			getPath: () => userDataDir,
			setPath: () => {},
			requestSingleInstanceLock: () => true,
			on: () => {},
			once: () => {},
			removeListener: () => {},
			whenReady: () => Promise.resolve(),
			quit: () => {},
			exit: () => {},
		},
		BrowserWindow: MockBrowserWindow,
		Menu: {
			buildFromTemplate: () => ({}),
			setApplicationMenu: () => {},
		},
		ipcMain: {
			handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
				handlers.set(channel, fn);
			},
			on: () => {},
		},
		nativeTheme: {},
		session: {
			defaultSession: {
				setPermissionRequestHandler: () => {},
				setPermissionCheckHandler: () => {},
				webRequest: { onBeforeSendHeaders: () => {} },
			},
		},
		shell: {
			openPath: async (target: string) => {
				openedPaths.push(target);
				return "";
			},
			openExternal: async () => {},
		},
		dialog: {
			showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		},
	};

	const moduleInternal = Module as unknown as {
		_load: (request: string, parent: unknown, isMain: boolean) => unknown;
	};
	const originalLoad = moduleInternal._load;
	const originalDevUrl = process.env.LH_DEV_URL;
	const beforeUncaught = new Set(process.listeners("uncaughtException"));
	const beforeExit = new Set(process.listeners("exit"));
	const beforeSighup = new Set(process.listeners("SIGHUP"));

	process.env.LH_DEV_URL = origin;
	delete require.cache[mainPath];
	moduleInternal._load = (request: string, parent: unknown, isMain: boolean) => {
		if (request === "electron") return electronStub;
		return originalLoad.call(Module, request, parent, isMain);
	};

	try {
		require(mainPath);
		await ready;
	} finally {
		moduleInternal._load = originalLoad;
	}

	const handler = handlers.get("lh:open-course-file") as OpenCourseFileHandler | undefined;
	assert.ok(handler && lastWindow, "Expected lh:open-course-file handler and trusted window");

	const trustedWindow = lastWindow as MockBrowserWindow | null;
	assert.ok(trustedWindow, "Expected trusted window");
	const event = {
		sender: trustedWindow.webContents,
		senderFrame: trustedWindow.webContents.mainFrame,
	};

	const dispose = () => {
		if (originalDevUrl === undefined) delete process.env.LH_DEV_URL;
		else process.env.LH_DEV_URL = originalDevUrl;
		for (const listener of process.listeners("uncaughtException")) {
			if (!beforeUncaught.has(listener)) process.removeListener("uncaughtException", listener);
		}
		for (const listener of process.listeners("exit")) {
			if (!beforeExit.has(listener)) process.removeListener("exit", listener);
		}
		for (const listener of process.listeners("SIGHUP")) {
			if (!beforeSighup.has(listener)) process.removeListener("SIGHUP", listener);
		}
		delete require.cache[mainPath];
		server.closeAllConnections?.();
		server.close();
		rmSync(userDataDir, { recursive: true, force: true });
	};

	return { handler, event, openedPaths, dispose };
}

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("electron lh:open-course-file", () => {
	it("opens only exact listed file paths and refuses prefix-matching or unlisted paths", async () => {
		const harness = await loadOpenCourseFileHandler((chatId) =>
			chatId === "chat-1" ? ["/course/notes.pdf"] : null,
		);
		dispose = harness.dispose;

		await harness.handler(harness.event, "chat-1", "/course/notes.pdf");
		assert.deepEqual(harness.openedPaths, ["/course/notes.pdf"]);

		// Prefix-matching paths in either direction must be refused silently
		await harness.handler(harness.event, "chat-1", "/course/notes.pdf.bak");
		await harness.handler(harness.event, "chat-1", "/course/notes");
		await harness.handler(harness.event, "chat-1", "/other/secret.pdf");
		await harness.handler(harness.event, "chat-missing", "/course/notes.pdf");
		await harness.handler({ sender: {}, senderFrame: {} }, "chat-1", "/course/notes.pdf");

		assert.deepEqual(harness.openedPaths, ["/course/notes.pdf"]);
	});
});
