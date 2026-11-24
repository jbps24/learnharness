import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

type Handler = (event: unknown, chatId: unknown, filePath: unknown) => Promise<void>;

/** Pull the real lh:open-course-file handler out of main.cjs and run it against stubs. */
function fixture(options: { trusted?: boolean; sender?: boolean; ok?: boolean; secret?: string; json?: unknown; text?: string }) {
	const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
	const start = main.indexOf('ipcMain.handle("lh:open-course-file", ') + 'ipcMain.handle("lh:open-course-file", '.length;
	const end = main.indexOf("\n\t});", start) + 3;
	const source = main.slice(start, end);
	const opened: string[] = [];
	const fetched: string[] = [];
	const inits: ({ redirect?: string; headers?: Record<string, string> } | undefined)[] = [];
	const window = {};
	const handler = runInNewContext(`(${source})`, {
		trustedAppWindows: { has: (w: unknown) => (options.trusted ?? true) && w === window },
		BrowserWindow: { fromWebContents: () => window },
		trustedSender: () => options.sender ?? true,
		url: "http://localhost:3000/app",
		URL,
		HEADER: "x-learnharness-desktop",
		desktopAPISecret: options.secret ?? null,
		fetch: async (target: string, init?: { redirect?: string; headers?: Record<string, string> }) => {
			fetched.push(target);
			inits.push(init);
			return {
				ok: options.ok ?? true,
				json: async () => options.json,
				text: async () => options.text ?? "",
			};
		},
		shell: { openPath: async (p: string) => { opened.push(p); } },
	}) as Handler;
	return { handler, opened, fetched, inits };
}

const listed = { material: { files: [{ path: "/course/notes.pdf" }] } };

describe("lh:open-course-file in main", () => {
	it("opens exactly the listed path and queries the chat's course endpoint", async () => {
		const f = fixture({ json: listed });
		await f.handler({ sender: {} }, "chat 1", "/course/notes.pdf");
		assert.deepEqual(f.opened, ["/course/notes.pdf"]);
		assert.deepEqual(f.fetched, ["http://localhost:3000/api/chats/chat%201/course"]);
	});

	it("sends the desktop secret header with a manual redirect when a secret is set", async () => {
		const f = fixture({ json: listed, secret: "s3cret" });
		await f.handler({ sender: {} }, "chat-1", "/course/notes.pdf");
		assert.equal(f.inits[0]?.redirect, "manual");
		assert.equal(f.inits[0]?.headers?.["x-learnharness-desktop"], "s3cret");
	});

	it("sends no secret header when no secret is set", async () => {
		const f = fixture({ json: listed });
		await f.handler({ sender: {} }, "chat-1", "/course/notes.pdf");
		assert.equal(f.inits[0]?.redirect, "manual");
		assert.equal(f.inits[0]?.headers, undefined);
	});

	it("refuses a path that only starts with a listed path", async () => {
		const f = fixture({ json: listed });
		await f.handler({ sender: {} }, "chat-1", "/course/notes");
		assert.deepEqual(f.opened, []);
	});

	it("refuses a sender that fails the origin check", async () => {
		const f = fixture({ json: listed, sender: false });
		await f.handler({ sender: {} }, "chat-1", "/course/notes.pdf");
		assert.deepEqual(f.opened, []);
		assert.deepEqual(f.fetched, []);
	});

	it("refuses an untrusted window", async () => {
		const f = fixture({ json: listed, trusted: false });
		await f.handler({ sender: {} }, "chat-1", "/course/notes.pdf");
		assert.deepEqual(f.opened, []);
	});

	it("refuses non-string or empty arguments and failed responses", async () => {
		const f = fixture({ json: listed });
		await f.handler({ sender: {} }, 1, "/course/notes.pdf");
		await f.handler({ sender: {} }, "chat-1", "");
		assert.deepEqual(f.opened, []);
		const bad = fixture({ json: listed, ok: false });
		await bad.handler({ sender: {} }, "chat-1", "/course/notes.pdf");
		assert.deepEqual(bad.opened, []);
	});
});
