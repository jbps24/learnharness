import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AGY_WORKSPACES_DIR, PATHS } from "../config.ts";
import {
	deleteLink,
	fingerprint,
	readLink,
	removeWorkspace,
	workspaceFor,
	writeLink,
} from "../src/agent/antigravity/link.ts";

const createdWorkspaces: string[] = [];

function trackChat(chatId: string): string {
	createdWorkspaces.push(chatId);
	return chatId;
}

afterEach(() => {
	while (createdWorkspaces.length > 0) {
		const id = createdWorkspaces.pop()!;
		try {
			removeWorkspace(id);
		} catch {
			// Best-effort cleanup when testing stubs or invalid ids.
		}
	}
});

function listFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

/** The plan fixes no link file name or place: find it as the file writeLink adds to the store. */
function writeAndLocateLink(chatId: string, link: { conversationId: string; fingerprint: string }): string {
	workspaceFor(chatId);
	const before = new Set(listFiles(AGY_WORKSPACES_DIR));
	writeLink(chatId, link);
	const added = listFiles(AGY_WORKSPACES_DIR).filter((file) => !before.has(file));
	assert.equal(added.length, 1, `expected writeLink to add exactly one file, got ${added.join(", ")}`);
	return added[0]!;
}

function sampleTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "quiz",
		description: "Ask a quiz",
		parameters: {
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		},
		...overrides,
	};
}

function sampleMessages(): Message[] {
	const user: UserMessage = { role: "user", content: "Teach addition", timestamp: 1000 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Let's try one." },
			{ type: "toolCall", id: "tc-1", name: "quiz", arguments: { question: "1+1?" } },
		],
		api: "antigravity-cli",
		provider: "antigravity",
		model: "default",
		stopReason: "toolUse",
		timestamp: 2000,
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "quiz",
		content: [{ type: "text", text: "2" }],
		isError: false,
		timestamp: 3000,
	};
	return [user, assistant, toolResult];
}

describe("antigravity link store", () => {
	// plan 019 part 1: workspace path under LH_DATA_DIR, fixed per chat
	it("places each chat workspace under LH_DATA_DIR and returns the same path on repeat calls", () => {
		const chatId = trackChat("chat_ws_location_1");
		const ws1 = workspaceFor(chatId);
		const ws2 = workspaceFor(chatId);
		assert.ok(ws1.length > 0);
		assert.equal(ws1, ws2);
		assert.ok(!path.relative(PATHS.data, ws1).startsWith(".."), `expected ${ws1} under ${PATHS.data}`);
		assert.ok(!path.relative(AGY_WORKSPACES_DIR, ws1).startsWith(".."), `expected ${ws1} under ${AGY_WORKSPACES_DIR}`);
	});

	// plan 019 part 1: created 0700 with .agents/mcp_config.json {"mcpServers":{}} 0600
	it("creates the workspace 0700 with .agents/mcp_config.json {\"mcpServers\":{}} 0600", () => {
		const chatId = trackChat("chat_ws_perms_1");
		const ws = workspaceFor(chatId);
		assert.equal(fs.statSync(ws).mode & 0o777, 0o700);
		const mcpPath = path.join(ws, ".agents", "mcp_config.json");
		assert.equal(fs.existsSync(mcpPath), true);
		assert.equal(fs.statSync(mcpPath).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(fs.readFileSync(mcpPath, "utf8")), { mcpServers: {} });
	});

	// plan 019 part 1: link round trip
	it("round-trips a link with conversationId and fingerprint", () => {
		const chatId = trackChat("chat_link_roundtrip_1");
		const link = { conversationId: "conv-abc-123", fingerprint: "fp-deadbeef" };
		writeLink(chatId, link);
		assert.deepEqual(readLink(chatId), link);
	});

	// plan 019 part 1: link file 0600
	it("writes the link file with mode 0600", () => {
		const chatId = trackChat("chat_link_perms_1");
		const linkFile = writeAndLocateLink(chatId, { conversationId: "conv-1", fingerprint: "fp-1" });
		assert.equal(fs.statSync(linkFile).mode & 0o777, 0o600);
	});

	// plan 019 part 1: missing link reads as none
	it("reads a missing link as null", () => {
		const chatId = trackChat("chat_link_missing_1");
		assert.equal(readLink(chatId), null);
	});

	// plan 019 part 1: corrupt link reads as none
	it("reads a corrupt or invalidly shaped link as null", () => {
		const chatId = trackChat("chat_link_corrupt_1");
		const linkFile = writeAndLocateLink(chatId, { conversationId: "conv-1", fingerprint: "fp-1" });

		fs.writeFileSync(linkFile, "{not valid json", "utf8");
		assert.equal(readLink(chatId), null);

		fs.writeFileSync(linkFile, "{}", "utf8");
		assert.equal(readLink(chatId), null);
	});

	// plan 019 part 1: deleteLink removes the link and tolerates missing links
	it("deletes an existing link and is a no-op when already missing", () => {
		const chatId = trackChat("chat_link_delete_1");
		writeLink(chatId, { conversationId: "conv-2", fingerprint: "fp-2" });
		assert.notEqual(readLink(chatId), null);
		deleteLink(chatId);
		assert.equal(readLink(chatId), null);
		deleteLink(chatId);
		assert.equal(readLink(chatId), null);
	});

	// plan 019 part 1: removeWorkspace removes the chat workspace
	it("removes the chat workspace directory and tolerates missing workspaces", () => {
		const chatId = trackChat("chat_ws_remove_1");
		const ws = workspaceFor(chatId);
		writeLink(chatId, { conversationId: "conv-3", fingerprint: "fp-3" });
		assert.equal(fs.existsSync(ws), true);
		removeWorkspace(chatId);
		assert.equal(fs.existsSync(ws), false);
		removeWorkspace(chatId);
	});

	// plan 019 part 1: a chat id that is not a safe path segment is refused
	it("refuses chat ids that are not safe path segments", () => {
		const unsafeIds = ["", ".", "..", "../escape", "a/b", "a\\b"];
		for (const badId of unsafeIds) {
			assert.throws(() => workspaceFor(badId));
			assert.throws(() => readLink(badId));
			assert.throws(() => writeLink(badId, { conversationId: "c", fingerprint: "f" }));
			assert.throws(() => deleteLink(badId));
			assert.throws(() => removeWorkspace(badId));
		}
	});
});

describe("antigravity fingerprint", () => {
	// plan 019 part 1: fingerprint changes with system prompt
	it("is deterministic and changes when the system prompt changes", () => {
		const tools = [sampleTool()];
		const messages = sampleMessages();
		const fp1 = fingerprint("Teach carefully.", tools, messages);
		const fp2 = fingerprint("Teach carefully.", tools, messages);
		assert.ok(fp1.length > 0);
		assert.equal(fp1, fp2);
		assert.notEqual(fp1, fingerprint("Teach quickly.", tools, messages));
	});

	// plan 019 part 1: fingerprint changes with tools
	it("changes when tools are added, removed, or modified", () => {
		const messages = sampleMessages();
		const base = fingerprint("Prompt", [sampleTool()], messages);
		assert.notEqual(base, fingerprint("Prompt", [], messages));
		assert.notEqual(base, fingerprint("Prompt", [sampleTool({ description: "Different" })], messages));
		assert.notEqual(base, fingerprint("Prompt", [sampleTool({ name: "other" })], messages));
	});

	// plan 019 part 1: fingerprint changes with any message content
	it("changes when any message content changes", () => {
		const tools = [sampleTool()];
		const base = fingerprint("Prompt", tools, sampleMessages());

		const editedUser = sampleMessages();
		(editedUser[0] as UserMessage).content = "Teach multiplication";
		assert.notEqual(base, fingerprint("Prompt", tools, editedUser));

		const editedAssistant = sampleMessages();
		const assistant = editedAssistant[1] as AssistantMessage;
		assistant.content = [
			{ type: "text", text: "Changed text." },
			assistant.content[1]!,
		];
		assert.notEqual(base, fingerprint("Prompt", tools, editedAssistant));

		const editedResult = sampleMessages();
		(editedResult[2] as ToolResultMessage).content = [{ type: "text", text: "3" }];
		assert.notEqual(base, fingerprint("Prompt", tools, editedResult));
	});

	// plan 019 part 1: fingerprint changes with a tool-call id
	it("changes when a tool-call id or toolResult toolCallId changes", () => {
		const tools = [sampleTool()];
		const base = fingerprint("Prompt", tools, sampleMessages());

		const editedAssistantId = sampleMessages();
		const assistant = editedAssistantId[1] as AssistantMessage;
		const call = assistant.content[1]!;
		if (call.type === "toolCall") {
			assistant.content = [assistant.content[0]!, { ...call, id: "tc-2" }];
		}
		assert.notEqual(base, fingerprint("Prompt", tools, editedAssistantId));

		const editedResultId = sampleMessages();
		(editedResultId[2] as ToolResultMessage).toolCallId = "tc-2";
		assert.notEqual(base, fingerprint("Prompt", tools, editedResultId));
	});

	// plan 019 part 1: fingerprint does not change with timestamps, usage or message ids
	it("does not change with timestamps, usage, or message ids", () => {
		const tools = [sampleTool()];
		const base = fingerprint("Prompt", tools, sampleMessages());

		const altered = sampleMessages().map((msg, idx) => ({
			...msg,
			id: `msg-${idx + 99}`,
			timestamp: msg.timestamp + 50_000,
			...(msg.role === "assistant"
				? {
						usage: {
							input: 999,
							output: 888,
							cacheRead: 777,
							cacheWrite: 666,
							totalTokens: 3330,
							cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
						},
					}
				: {}),
		})) as Message[];

		assert.equal(fingerprint("Prompt", tools, altered), base);
	});
});

describe("antigravity link store and fingerprint regression checks", () => {
	it("reads a link with an empty fingerprint as null", () => {
		const chatId = trackChat("chat_link_empty_fp_1");
		const linkFile = writeAndLocateLink(chatId, { conversationId: "conv-1", fingerprint: "fp-1" });
		fs.writeFileSync(linkFile, JSON.stringify({ conversationId: "conv-1", fingerprint: "" }), "utf8");
		assert.equal(readLink(chatId), null);
	});

	it("removes the link file along with the workspace", () => {
		const chatId = trackChat("chat_ws_remove_link_1");
		const ws = workspaceFor(chatId);
		writeLink(chatId, { conversationId: "conv-remove-link", fingerprint: "fp-remove-link" });
		assert.notEqual(readLink(chatId), null);
		removeWorkspace(chatId);
		assert.equal(fs.existsSync(ws), false);
		assert.equal(readLink(chatId), null);
	});

	it("changes when a toolResult flips isError", () => {
		const tools = [sampleTool()];
		const base = fingerprint("Prompt", tools, sampleMessages());
		const errored = sampleMessages();
		(errored[2] as ToolResultMessage).isError = true;
		assert.notEqual(base, fingerprint("Prompt", tools, errored));
	});

	it("ignores system messages in the message list", () => {
		const tools = [sampleTool()];
		const messages = sampleMessages();
		const sys: Message = { role: "system", content: "Prompt", timestamp: 9999 };
		assert.equal(fingerprint("Prompt", tools, [sys, ...messages]), fingerprint("Prompt", tools, messages));
	});
});
