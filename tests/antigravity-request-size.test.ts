import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Tool } from "@earendil-works/pi-ai";
import { createAntigravityStream, type RunAntigravity } from "../src/agent/antigravity/stream.ts";
import { AGY_MAX_INPUT_BYTES, buildAntigravityPrompt } from "../src/agent/antigravity/request.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { toClaudeInput } from "../src/agent/claude-code/transcript.ts";

// agy cuts every input message after exactly 192,000 bytes, keeps the head
// and appends "<truncated N bytes>" (verified 2026-11-19 in agy's own
// transcript_full.jsonl): the newest conversation turns are what get lost.

const model = ANTIGRAVITY_MODELS[0]!;
const tool: Tool = { name: "quiz", description: "Ask a quiz", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } };
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function capture() {
	const calls: { cwd: string; prompt: string }[] = [];
	const run: RunAntigravity = (_binary, _args, options) => {
		calls.push({ cwd: options.cwd, prompt: readFileSync(join(options.cwd, "request.txt"), "utf8") });
		const out = JSON.stringify({ event: "result", result: { status: "SUCCESS", structured_output: { text: "ok", toolCalls: [] } } }) + "\n";
		return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(out)}));`], { stdio: "pipe" });
	};
	return { run, calls };
}

function userContext(content: string | ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[]) {
	return normalizeContext({ systemPrompt: "Teach carefully", tools: [tool], messages: [{ role: "user", content, timestamp: 0 }] });
}

test("the CLI's input cap is 192,000 bytes", () => {
	assert.equal(AGY_MAX_INPUT_BYTES, 192_000);
});

test("the request builder reproduces the exact prompt the CLI receives, image lines included", async () => {
	const context = userContext([{ type: "text", text: "Look at this" }, { type: "image", mimeType: "image/png", data: PNG }]);
	const { run, calls } = capture();
	await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	const built = buildAntigravityPrompt(toClaudeInput(context.messages), (index, ext) => join(calls[0]!.cwd, `input-${index}.${ext}`));
	assert.equal(built.prompt, calls[0]!.prompt);
	assert.deepEqual(built.images, [{ path: join(calls[0]!.cwd, "input-0.png"), data: PNG }]);
});

test("the request builder rejects image types the CLI cannot read", () => {
	const input = toClaudeInput(userContext([{ type: "image", mimeType: "image/tiff", data: PNG }]).messages);
	assert.throws(() => buildAntigravityPrompt(input, () => "/x"), /Unsupported Antigravity image type: image\/tiff/);
});

/** Pads the user turn so the request lands exactly `bytes` bytes long, using a
 *  two-byte character: the cap counts UTF-8 bytes, not characters. */
function contextOfBytes(bytes: number) {
	const overhead = Buffer.byteLength(buildAntigravityPrompt(toClaudeInput(userContext("").messages), () => "").prompt);
	const room = bytes - overhead;
	const text = "ä".repeat(Math.floor(room / 2)) + "a".repeat(room % 2);
	const context = userContext(text);
	assert.equal(Buffer.byteLength(buildAntigravityPrompt(toClaudeInput(context.messages), () => "").prompt), bytes);
	return context;
}

test("a request at the cap is sent", async () => {
	const { run, calls } = capture();
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, contextOfBytes(AGY_MAX_INPUT_BYTES)).result();
	assert.equal(result.stopReason, "stop");
	assert.equal(calls.length, 1);
});

test("a request over the cap never reaches the CLI and fails with a clear error", async () => {
	const { run, calls } = capture();
	const context = contextOfBytes(AGY_MAX_INPUT_BYTES + 1);
	assert.ok((context.messages[0]!.content as string).length < AGY_MAX_INPUT_BYTES, "characters alone stay under the cap");
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context);
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(calls.length, 0);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "This conversation is too large for the Antigravity CLI (188 KB, limit 187 KB). Compact the chat or choose another model.");
	assert.equal(events.at(-1)?.type, "error");
});
