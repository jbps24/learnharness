import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getSupportedThinkingLevels, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_FALLBACK_MODEL, ANTIGRAVITY_NO_ANSWER, createAntigravityStream, inventedTurns, parseActions, type RunAntigravity } from "../src/agent/antigravity/stream.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";
import { SETTINGS_SECTIONS } from "../src/server/settings-body.ts";

const model = ANTIGRAVITY_MODELS[0]!;
const tool: Tool = { name: "quiz", description: "Ask a quiz", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } };
const context = normalizeContext({ systemPrompt: "Teach carefully", tools: [tool], messages: [{ role: "user", content: "Teach addition", timestamp: 0 }] });

function fakeRun(output: { usage?: unknown; status?: string; error?: string }, code?: number): { run: RunAntigravity; calls: { args: string[]; cwd: string; prompt: string; settings: Record<string, unknown> }[] };
function fakeRun(output: { usage?: unknown }, code = 0) {
	const calls: { args: string[]; cwd: string; prompt: string; settings: Record<string, unknown> }[] = [];
	const run: RunAntigravity = (_binary, args, options) => {
		assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
		assert.equal(statSync(options.cwd + "/request.txt").mode & 0o777, 0o600);
		calls.push({ args, cwd: options.cwd, prompt: readFileSync(options.cwd + "/request.txt", "utf8"), settings: JSON.parse(args[args.indexOf("--settings") + 1]!) });
		const lines = [
			...(output.usage ? [JSON.stringify({ event: "step_update", usage: output.usage })] : []),
			JSON.stringify({ event: "result", result: output }),
		].join("\n") + "\n";
		return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(lines)}); process.exitCode=${code}; });`], { stdio: "pipe" });
	};
	return { run, calls };
}

function success(structured_output: unknown) {
	return { status: "SUCCESS", structured_output, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } };
}

test("Antigravity emits admitted harness tools and keeps subscription auth/overages explicit", async () => {
	const { run, calls } = fakeRun(success({ text: "Try this", toolCalls: [{ name: "quiz", arguments: { question: "1+1?" } }] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { reasoning: "medium" });
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.map((b) => b.type), ["text", "toolCall"]);
	assert.equal(result.usage.input, 70);
	assert.equal(result.usage.cacheRead, 30);
	assert.equal(result.usage.totalTokens, 120);
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(calls[0]!.settings.useG1Credits, false);
	assert.ok(calls[0]!.prompt.includes("Teach carefully"));
	assert.ok(calls[0]!.prompt.includes("Teach addition"));
	assert.ok(!calls[0]!.args.includes("--model"));
	assert.ok(!calls[0]!.args.includes("--dangerously-skip-permissions"));
	assert.equal(existsSync(calls[0]!.cwd), false);
});

test("Antigravity requests explicit model slugs without falling back", async () => {
	const { run, calls } = fakeRun(success({ text: "Done", toolCalls: [] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(ANTIGRAVITY_MODELS[1]!, context);
	await stream.result();
	assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1], ANTIGRAVITY_MODELS[1]!.id);
});

// Checked against `agy models` and `--effort` validation with CLI 1.5.11.
test("Antigravity lists one entry per model family with the CLI's supported thinking levels", () => {
	assert.deepEqual(ANTIGRAVITY_MODELS.map((m) => [m.id, m.name, getSupportedThinkingLevels(m)]), [
		["default", "Antigravity · CLI default", ["low", "medium", "high"]],
		["gemini-4-hydrogen", "Gemini 4 Hydrogen", ["low", "medium", "high", "xhigh"]],
		["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
		["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]],
		["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]],
		["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]],
		["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
	]);
});

test("Antigravity passes the selected thinking level to the CLI as --effort", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	const { run, calls } = fakeRun(success({ text: "Done", toolCalls: [] }));
	await createAntigravityStream(run, () => "/fake/agy")(hydrogen, context, { reasoning: "xhigh" }).result();
	const args = calls[0]!.args;
	assert.equal(args[args.indexOf("--model") + 1], "gemini-4-hydrogen");
	assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
});

test("a real Pi agent executes harness tools and replays tool results to the next CLI request", async () => {
	let index = 0;
	const responses = [
		fakeRun(success({ text: "", toolCalls: [{ name: "check", arguments: { answer: 2 } }] })),
		fakeRun(success({ text: "Correct: two", toolCalls: [] })),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const agent = new Agent({ initialState: {
		model, systemPrompt: "Teach addition", tools: [{ name: "check", label: "Check", description: "Check the answer", parameters: Type.Object({ answer: Type.Number() }),
			execute: async (_id, args) => ({ content: [{ type: "text", text: `Answer ${(args as { answer: number }).answer} is correct` }], details: {} }),
		}],
	}, streamFn: createAntigravityStream(run, () => "/fake/agy") });
	await agent.prompt("What is one plus one?");
	assert.equal(index, 2);
	assert.ok(responses[1]!.calls[0]!.prompt.includes("Answer 2 is correct"));
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.ok(JSON.stringify(agent.state.messages.at(-1)).includes("Correct: two"));
});

test("invalid tool names and missing structured output fail without executing tools", async () => {
	assert.throws(() => parseActions({ text: "", toolCalls: [{ name: "bash", arguments: {} }] }, [tool]), /undeclared/);
	for (const [payload, attempts] of [[undefined, 2], [{ text: "", toolCalls: [{ name: "bash", arguments: {} }] }, 1]] as const) {
		const { run, calls } = fakeRun(success(payload));
		const stream = createAntigravityStream(run, () => "/fake/agy")(model, context);
		assert.equal((await stream.result()).stopReason, "error");
		// Consume through cleanup, which follows the terminal event.
		for await (const _event of stream) { /* drain */ }
		assert.equal(calls.length, attempts);
		assert.equal(existsSync(calls[0]!.cwd), false);
	}
});

// plan 005 part 1: existing test renamed and asserts second run uses --model claude-sonnet-5-5 with equal prompt
test("a successful run without structured output is retried once on the fallback model", async () => {
	let index = 0;
	const responses = [fakeRun(success(undefined)), fakeRun(success({ text: "Second try", toolCalls: [] }))];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(index, 2);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content, [{ type: "text", text: "Second try" }]);
	assert.equal(responses[1]!.calls[0]!.prompt, responses[0]!.calls[0]!.prompt);
	assert.equal(responses[1]!.calls[0]!.args[responses[1]!.calls[0]!.args.indexOf("--model") + 1], "claude-sonnet-5-5");
	assert.equal(result.usage.output, 20);
});

test("a second run without structured output ends the turn with a specific error", async () => {
	const { run, calls } = fakeRun(success(undefined));
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context);
	const result = await stream.result();
	for await (const _event of stream) { /* drain */ }
	assert.equal(calls.length, 2);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "The Antigravity model did not finish its answer (twice). Try again or choose another model.");
	assert.equal(existsSync(calls[0]!.cwd), false);
});

test("failed runs are not retried", async () => {
	const { run, calls } = fakeRun({ status: "ERROR", error: "quota exhausted" }, 1);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(result.errorMessage, "quota exhausted");
	assert.equal(calls.length, 1);
});

test("CLI authentication errors remain errors, including nonzero exits", async () => {
	const { run } = fakeRun({ status: "ERROR", error: "authentication required" }, 1);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /authentication required/);
	const missing = await createAntigravityStream(run, () => null)(model, context).result();
	assert.match(missing.errorMessage!, /not found/);
});

test("cancellation terminates a waiting child and removes private files", async () => {
	const controller = new AbortController();
	let cwd = "";
	const run: RunAntigravity = (_binary, _args, options) => {
		cwd = options.cwd;
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe" });
		setTimeout(() => controller.abort(), 30);
		return child;
	};
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { signal: controller.signal } as SimpleStreamOptions);
	for await (const _event of stream) { /* drain through cleanup */ }
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(existsSync(cwd), false);
});

test("Antigravity settings sanitize, validate, and report unknown prices and limits", () => {
	assert.deepEqual(SETTINGS_SECTIONS.antigravity({ enabled: true }), { ok: true, settings: { enabled: true } });
	assert.equal(SETTINGS_SECTIONS.antigravity({ enabled: "true" }).ok, false);
	assert.deepEqual(sanitizeUserSettings({ antigravity: { enabled: true } })?.antigravity, { enabled: true });
	const dto = toModelDto(model);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, null);
	assert.equal(dto.maxTokens, null);
	assert.equal(callCost({ inputTokens: 100, outputTokens: 10 }, "antigravity:default"), null);
});

function successWith(structured_output: unknown, response?: unknown, output_tokens = 20) {
	return {
		...success(structured_output),
		...(response !== undefined ? { response } : {}),
		usage: { input_tokens: 100, output_tokens, cache_read_tokens: 30 },
	};
}

function replaceModelArg(args: string[], modelId: string): string[] {
	const index = args.indexOf("--model");
	if (index === -1) return [...args, "--model", modelId];
	const next = [...args];
	next[index + 1] = modelId;
	return next;
}

// plan 005 part 1: ANTIGRAVITY_FALLBACK_MODEL equals "claude-sonnet-5-5"
test("ANTIGRAVITY_FALLBACK_MODEL is claude-sonnet-5-5", () => {
	assert.equal(ANTIGRAVITY_FALLBACK_MODEL, "claude-sonnet-5-5");
});

// plan 005 part 1: inventedTurns detects line-start transcript markers and rejects non-strings, inline markers, leading spaces, and other brackets
test("inventedTurns detects invented transcript turns only at line start", () => {
	for (const sample of [
		"Text\n\n[tool result explain]\n{…}",
		"[assistant]\nHi",
		"x\n[tool call quiz] {}",
		"x\n[user]\nhello",
		"x\n[tool result quiz error]\nboom",
	]) {
		assert.equal(inventedTurns(sample), true, `expected true for ${JSON.stringify(sample)}`);
	}
	for (const sample of [
		undefined,
		null,
		42,
		"",
		"plain prose",
		"see [assistant] inline",
		"  [assistant]",
		"[Session note] x",
		"[Image: read this file]",
	]) {
		assert.equal(inventedTurns(sample), false, `expected false for ${JSON.stringify(sample)}`);
	}
});

// plan 005 part 1: Gemini 4 Hydrogen medium with invented turns falls back to Sonnet, keeps medium effort, sets message.model, and uses second run usage
test("invented turns on Gemini 4 Hydrogen medium falls back to Sonnet", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	let index = 0;
	const responses = [
		fakeRun(successWith({ text: "First try", toolCalls: [] }, "Prose\n[tool result explain]\n{}", 20)),
		fakeRun(successWith({ text: "Second try", toolCalls: [] }, "Clean answer", 45)),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const stream = createAntigravityStream(run, () => "/fake/agy")(hydrogen, context, { reasoning: "medium" });
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(index, 2);
	assert.equal(responses[1]!.calls[0]!.prompt, responses[0]!.calls[0]!.prompt);
	assert.deepEqual(responses[1]!.calls[0]!.args, replaceModelArg(responses[0]!.calls[0]!.args, "claude-sonnet-5-5"));
	assert.equal(responses[1]!.calls[0]!.args[responses[1]!.calls[0]!.args.indexOf("--effort") + 1], "medium");
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content, [{ type: "text", text: "Second try" }]);
	assert.equal(result.model, "claude-sonnet-5-5");
	assert.equal(result.provider, hydrogen.provider);
	assert.equal(result.api, hydrogen.api);
	assert.equal(result.usage.output, 45);
	const contentEvents = events.filter((e) => e.type === "text_start" || e.type === "text_delta" || e.type === "text_end");
	assert.ok(contentEvents.length > 0);
	for (const event of contentEvents) {
		assert.equal(event.partial.model, "claude-sonnet-5-5");
	}
});

// plan 005 part 1: xhigh reasoning on Gemini 4 Hydrogen maps to high on the Sonnet fallback
test("xhigh reasoning on Gemini 4 Hydrogen maps to high effort on Sonnet fallback", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	let index = 0;
	const responses = [fakeRun(success(undefined)), fakeRun(success({ text: "Second try", toolCalls: [] }))];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const result = await createAntigravityStream(run, () => "/fake/agy")(hydrogen, context, { reasoning: "xhigh" }).result();
	assert.equal(index, 2);
	assert.equal(result.stopReason, "stop");
	const firstArgs = responses[0]!.calls[0]!.args;
	const secondArgs = responses[1]!.calls[0]!.args;
	assert.equal(firstArgs[firstArgs.indexOf("--effort") + 1], "xhigh");
	assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "claude-sonnet-5-5");
	assert.equal(secondArgs[secondArgs.indexOf("--effort") + 1], "high");
});

// plan 005 part 1: max reasoning also becomes high on the Sonnet fallback run
test("max reasoning maps to high effort on the Sonnet fallback run", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	let index = 0;
	const responses = [fakeRun(success(undefined)), fakeRun(success({ text: "Second try", toolCalls: [] }))];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const result = await createAntigravityStream(run, () => "/fake/agy")(hydrogen, context, { reasoning: "max" }).result();
	assert.equal(index, 2);
	assert.equal(result.stopReason, "stop");
	const secondArgs = responses[1]!.calls[0]!.args;
	assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "claude-sonnet-5-5");
	assert.equal(secondArgs[secondArgs.indexOf("--effort") + 1], "high");
});

// plan 005 part 1: unsupported reasoning level or omitted reasoning omits --effort on the fallback run
test("unsupported or omitted reasoning omits --effort on the Sonnet fallback run", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	for (const options of [{}, { reasoning: "minimal" as const }] as SimpleStreamOptions[]) {
		let index = 0;
		const responses = [fakeRun(success(undefined)), fakeRun(success({ text: "Second try", toolCalls: [] }))];
		const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
		const result = await createAntigravityStream(run, () => "/fake/agy")(hydrogen, context, options).result();
		assert.equal(index, 2);
		assert.equal(result.stopReason, "stop");
		assert.ok(!responses[0]!.calls[0]!.args.includes("--effort"));
		assert.ok(!responses[1]!.calls[0]!.args.includes("--effort"));
	}
});

// plan 005 part 1: model default has no --model on first run and adds --model claude-sonnet-5-5 on fallback
test("model default adds --model claude-sonnet-5-5 on the fallback run", async () => {
	let index = 0;
	const responses = [
		fakeRun(successWith({ text: "First", toolCalls: [] }, "[assistant]\nHi")),
		fakeRun(success({ text: "Second", toolCalls: [] })),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(index, 2);
	assert.equal(result.stopReason, "stop");
	assert.ok(!responses[0]!.calls[0]!.args.includes("--model"));
	assert.equal(responses[1]!.calls[0]!.args[responses[1]!.calls[0]!.args.indexOf("--model") + 1], "claude-sonnet-5-5");
});

// plan 005 part 1: selected model claude-sonnet-5-5 retries on Sonnet again after an unusable first run
test("selected model claude-sonnet-5-5 retries on Sonnet again", async () => {
	const sonnet = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-sonnet-5-5")!;
	let index = 0;
	const responses = [
		fakeRun(successWith({ text: "First", toolCalls: [] }, "x\n[user]\nhello")),
		fakeRun(success({ text: "Second", toolCalls: [] })),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const result = await createAntigravityStream(run, () => "/fake/agy")(sonnet, context).result();
	assert.equal(index, 2);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.model, "claude-sonnet-5-5");
	assert.equal(responses[1]!.calls[0]!.args[responses[1]!.calls[0]!.args.indexOf("--model") + 1], "claude-sonnet-5-5");
});

// plan 005 part 1: two runs both with invented turns end with ANTIGRAVITY_NO_ANSWER and clean up cwd
test("two runs both with invented turns end with ANTIGRAVITY_NO_ANSWER", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	let index = 0;
	const responses = [
		fakeRun(successWith({ text: "First", toolCalls: [] }, "[assistant]\nHi")),
		fakeRun(successWith({ text: "Second", toolCalls: [] }, "x\n[tool call quiz] {}")),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const stream = createAntigravityStream(run, () => "/fake/agy")(hydrogen, context);
	const result = await stream.result();
	for await (const _event of stream) { /* drain */ }
	assert.equal(index, 2);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, ANTIGRAVITY_NO_ANSWER);
	assert.equal(existsSync(responses[0]!.calls[0]!.cwd), false);
	assert.equal(existsSync(responses[1]!.calls[0]!.cwd), false);
});

// plan 005 part 1: second unusable run for either reason in any combination throws ANTIGRAVITY_NO_ANSWER
test("mixed unusable runs end with ANTIGRAVITY_NO_ANSWER", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	const pairs = [
		[success(undefined), successWith({ text: "Second", toolCalls: [] }, "x\n[tool result quiz error]\nboom")],
		[successWith({ text: "First", toolCalls: [] }, "x\n[user]\nhello"), success(undefined)],
	] as const;
	for (const [first, second] of pairs) {
		let index = 0;
		const responses = [fakeRun(first), fakeRun(second)];
		const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
		const stream = createAntigravityStream(run, () => "/fake/agy")(hydrogen, context);
		const result = await stream.result();
		for await (const _event of stream) { /* drain */ }
		assert.equal(index, 2);
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, ANTIGRAVITY_NO_ANSWER);
		assert.equal(existsSync(responses[0]!.calls[0]!.cwd), false);
		assert.equal(existsSync(responses[1]!.calls[0]!.cwd), false);
	}
});

// plan 005 part 1: clean run whose response is plain prose followed by envelope JSON runs once and keeps selected model
test("clean run with plain prose and envelope JSON in response uses one run and keeps selected model", async () => {
	const hydrogen = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	const { run, calls } = fakeRun(successWith({ text: "Clean reply", toolCalls: [] }, 'Here is the answer.\n{"text":"Clean reply","toolCalls":[]}'));
	const result = await createAntigravityStream(run, () => "/fake/agy")(hydrogen, context).result();
	assert.equal(calls.length, 1);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content, [{ type: "text", text: "Clean reply" }]);
	assert.equal(result.model, "gemini-4-hydrogen");
});
