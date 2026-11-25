import assert from "node:assert/strict";
import test from "node:test";

import { salvageToolCall, stripReplayLines } from "../src/agent/claude-code/text-tool-calls.ts";

// plan 017 part 1: trailing `[tool call quiz] {…}` is cut and the prose kept, with trailing whitespace trimmed
test("stripReplayLines cuts trailing [tool call quiz] and trims trailing whitespace from kept prose", () => {
	const result = stripReplayLines('Here is a quick question.   \n\n[tool call quiz] {"type":"check"}');
	assert.deepEqual(result, {
		kept: "Here is a quick question.",
		cut: '[tool call quiz] {"type":"check"}',
	});
});

// plan 017 part 1: whole text being a replay call leaves empty kept
test("stripReplayLines leaves kept empty when the whole text is a replay call", () => {
	const result = stripReplayLines('[tool call quiz] {"type":"check"}');
	assert.deepEqual(result, {
		kept: "",
		cut: '[tool call quiz] {"type":"check"}',
	});
});

// plan 017 part 1: a call followed by `\n\n[tool result quiz]\n{"kind":"quiz"}` is cut whole
test("stripReplayLines cuts a call followed by an invented tool result whole", () => {
	const result = stripReplayLines('Let us check.\n\n[tool call quiz] {"type":"check"}\n\n[tool result quiz]\n{"kind":"quiz"}');
	assert.deepEqual(result, {
		kept: "Let us check.",
		cut: '[tool call quiz] {"type":"check"}\n\n[tool result quiz]\n{"kind":"quiz"}',
	});
});

// plan 017 part 1: `[assistant]` and `[user]` lines at line start are cut
test("stripReplayLines cuts [assistant] and [user] lines at line start", () => {
	const assistantResult = stripReplayLines("Prose.\n\n[assistant]");
	assert.equal(assistantResult.kept, "Prose.");
	assert.equal(assistantResult.cut, "[assistant]");

	const userResult = stripReplayLines("Prose.\n\n[user]");
	assert.equal(userResult.kept, "Prose.");
	assert.equal(userResult.cut, "[user]");
});

// plan 017 part 1: non-line-start, indented, [Image: …], [!IMPORTANT], and plain text are not cut
test("stripReplayLines leaves inline markers, leading-space markers, images, callouts, and plain text unchanged", () => {
	const cases = [
		"see [tool call quiz] inline",
		"  [tool call quiz] {}",
		"[Image: diagram.png]",
		"> [!IMPORTANT]\n> Remember this.",
		"[!IMPORTANT]\nRemember this.",
		"Plain text without replay lines.\nSecond line.",
	];

	for (const text of cases) {
		assert.deepEqual(stripReplayLines(text), { kept: text, cut: "" });
	}
});

// plan 017 part 1: a declared tool with valid JSON gives `{ name, arguments }`
test("salvageToolCall returns { name, arguments } for a declared tool with valid JSON", () => {
	const result = salvageToolCall('[tool call quiz] {"type":"check","prompt":"What is TCP?"}', new Set(["quiz"]));
	assert.deepEqual(result, {
		name: "quiz",
		arguments: { type: "check", prompt: "What is TCP?" },
	});
});

// plan 017 part 1: returns null for an undeclared name
test("salvageToolCall returns null for an undeclared tool name", () => {
	const result = salvageToolCall('[tool call quiz] {"type":"check"}', new Set(["read"]));
	assert.equal(result, null);
});

// plan 017 part 1: returns null for invalid JSON, a JSON array, or a bare header with no JSON
test("salvageToolCall returns null for invalid JSON, a JSON array, a bare header, or empty cut", () => {
	const tools = new Set(["quiz"]);
	assert.equal(salvageToolCall("[tool call quiz] {not valid json", tools), null);
	assert.equal(salvageToolCall("[tool call quiz] [1, 2, 3]", tools), null);
	assert.equal(salvageToolCall("[tool call quiz]", tools), null);
	assert.equal(salvageToolCall("", tools), null);
});

// plan 017 part 1: with two calls in the cut part, the first one is used
test("salvageToolCall uses the first call when two calls appear in the cut part", () => {
	const cut = '[tool call quiz] {"order":1}\n\n[tool call read] {"path":"notes.md"}';
	const result = salvageToolCall(cut, new Set(["quiz", "read"]));
	assert.deepEqual(result, {
		name: "quiz",
		arguments: { order: 1 },
	});
});
