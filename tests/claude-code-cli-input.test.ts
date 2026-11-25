import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, SystemMessage, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import { CLAUDE_TRANSCRIPT_END, toClaudeCliInput, toClaudeInput } from "../src/agent/claude-code/transcript.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

function system(content: string): SystemMessage {
	return { role: "system", content, toolsAdded: [READ_TOOL], timestamp: 0 };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-code-cli",
		provider: "claude-code",
		model: "opus",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: `${toolName}-1`, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

// plan 017 part 1: a single user message gives exactly today's output with no closing block
test("toClaudeCliInput passes a single user message through identically to toClaudeInput without a closing block", () => {
	const messages: Message[] = [system("You are a tutor."), user("what is a socket?")];
	assert.deepEqual(toClaudeCliInput(messages), toClaudeInput(messages));
});

// plan 017 part 1: a replayed conversation ends with a text block equal to CLAUDE_TRANSCRIPT_END
test("toClaudeCliInput appends CLAUDE_TRANSCRIPT_END as the final text block of a replayed conversation", () => {
	assert.ok(CLAUDE_TRANSCRIPT_END.length > 0);
	const messages: Message[] = [
		system("You are a tutor."),
		user("hi"),
		assistant([{ type: "text", text: "Hello." }]),
		user("next"),
	];
	const cliInput = toClaudeCliInput(messages);
	assert.deepEqual(cliInput.userContent.at(-1), { type: "text", text: CLAUDE_TRANSCRIPT_END });
});

// plan 017 part 1: past assistant text ending in `[tool call quiz] {…}` is replayed without that line, while real `toolCall` remains
test("toClaudeCliInput strips replay lines from past assistant text while keeping real toolCall blocks", () => {
	const messages: Message[] = [
		user("open notes.md"),
		assistant([
			{ type: "text", text: 'Reading it.\n\n[tool call quiz] {"type":"check"}' },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } },
		]),
		toolResult("read", "# Notes"),
		user("summarise it"),
	];
	const cliInput = toClaudeCliInput(messages);
	const replayed = cliInput.userContent
		.slice(0, -1)
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n");

	assert.equal(replayed.includes("[tool call quiz]"), false);
	assert.equal(replayed.includes("[assistant]\nReading it."), true);
	assert.equal(replayed.includes('[tool call read] {"path":"notes.md"}'), true);
});

// plan 017 part 1: a user message containing `[tool call quiz]` at line start is replayed unchanged
test("toClaudeCliInput replays a user message containing [tool call quiz] at line start unchanged", () => {
	const userText = 'Explain this:\n[tool call quiz] {"type":"check"}';
	const messages: Message[] = [
		user("hi"),
		assistant([{ type: "text", text: "Sure." }]),
		user(userText),
	];
	const cliInput = toClaudeCliInput(messages);
	const replayed = cliInput.userContent
		.slice(0, -1)
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n");

	assert.equal(replayed.includes(`[user]\n${userText}`), true);
});

// plan 017 part 1: `toClaudeInput` output is unchanged (agy)
test("toClaudeInput remains unchanged for agy without stripping or closing block", () => {
	const messages: Message[] = [
		user("hi"),
		assistant([{ type: "text", text: 'Done.\n\n[tool call quiz] {"type":"check"}' }]),
		user("next"),
	];
	const expected = [
		"[user]\nhi",
		'[assistant]\nDone.\n\n[tool call quiz] {"type":"check"}',
		"[user]\nnext",
	].join("\n\n");

	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("toClaudeInput keeps empty assistant text blocks while toClaudeCliInput omits them", () => {
	const messages: Message[] = [
		user("hi"),
		assistant([{ type: "text", text: "" }]),
		user("next"),
	];

	assert.deepEqual(toClaudeInput(messages).userContent, [
		{ type: "text", text: ["[user]\nhi", "[assistant]\n", "[user]\nnext"].join("\n\n") },
	]);
	assert.deepEqual(toClaudeCliInput(messages).userContent, [
		{ type: "text", text: ["[user]\nhi", "[user]\nnext"].join("\n\n") },
		{ type: "text", text: CLAUDE_TRANSCRIPT_END },
	]);
});
