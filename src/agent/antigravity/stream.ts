import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Api, type SimpleStreamOptions, type StreamFunction, type Tool, type JsonObject } from "@earendil-works/pi-ai";
import { externalCliEnv } from "../../core/auth-env.ts";
import { toClaudeInput } from "../claude-code/transcript.ts";
import { getAntigravityBinary } from "./binary.ts";
import { ANTIGRAVITY_MODELS } from "./provider.ts";
import { AGY_MAX_INPUT_BYTES, antigravityTooLargeMessage, buildAntigravityPrompt } from "./request.ts";

export const AGY_SESSION_SETTINGS = {
	useG1Credits: false,
	permissions: { deny: ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"] },
};

// The CLI generates an action envelope. Pi executes the declared harness tools,
// including questions that wait for the learner, then supplies results next turn.
// No shell/MCP tools or global permission changes are needed.
export function actionSchema(tools: Tool[]) {
	return {
		type: "object", additionalProperties: false,
		properties: {
			text: { type: "string" },
			toolCalls: { type: "array", maxItems: tools.length ? 16 : 0, items: {
				type: "object", additionalProperties: false,
				properties: { name: { type: "string", ...(tools.length ? { enum: tools.map((t) => t.name) } : {}) }, arguments: { type: "object", additionalProperties: true } },
				required: ["name", "arguments"],
			} },
		}, required: ["text", "toolCalls"],
	};
}

export function parseActions(value: unknown, tools: Tool[]): { text: string; toolCalls: { name: string; arguments: JsonObject }[] } {
	if (!value || typeof value !== "object") throw new Error("Antigravity returned no structured action output.");
	const raw = value as Record<string, unknown>;
	if (typeof raw.text !== "string" || !Array.isArray(raw.toolCalls) || raw.toolCalls.length > 16) throw new Error("Antigravity returned an invalid action envelope.");
	const toolCalls = raw.toolCalls.map((call: unknown) => {
		if (!call || typeof call !== "object") throw new Error("Antigravity returned an invalid tool call.");
		const c = call as Record<string, unknown>;
		if (typeof c.name !== "string" || !tools.some((t) => t.name === c.name) || !c.arguments || typeof c.arguments !== "object" || Array.isArray(c.arguments)) throw new Error("Antigravity requested an undeclared or invalid harness tool.");
		return { name: c.name, arguments: c.arguments as JsonObject };
	});
	return { text: raw.text, toolCalls };
}

/** The turn's error when agy returned no answer on the retry either. */
export const ANTIGRAVITY_NO_ANSWER = "The Antigravity model did not finish its answer (twice). Try again or choose another model.";

/** The model the one retry after an unusable run goes to. */
export const ANTIGRAVITY_FALLBACK_MODEL = "claude-sonnet-5-5";

/** True when agy's prose continues the transcript with turns it made up. */
export function inventedTurns(response: unknown): boolean {
	return typeof response === "string" && /^\[(user|assistant|tool call [^\]\n]+|tool result [^\]\n]+)\]/m.test(response);
}

export type RunAntigravity =(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export function createAntigravityStream(run: RunAntigravity = (binary, args, options) => spawn(binary, args, { ...options, stdio: "pipe" }), findBinary = getAntigravityBinary): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options = {}) => {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		void (async () => {
			let terminal: AssistantMessageEvent | undefined;
			let cwd: string | undefined;
			let child: ChildProcessWithoutNullStreams | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			const abort = () => {
				child?.kill("SIGTERM");
				killTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
				killTimer.unref();
			};
			try {
				if (options.signal?.aborted) throw new Error("Request was aborted");
				const binary = findBinary();
				if (!binary) throw new Error("Antigravity CLI not found. Install agy and sign in with your Google account.");
				cwd = await mkdtemp(join(tmpdir(), "learnharness-agy-"));
				await mkdir(join(cwd, ".agents"));
				// Workspace MCP configuration prevents automatic project server imports.
				await writeFile(join(cwd, ".agents", "mcp_config.json"), '{"mcpServers":{}}', { mode: 0o600 });
				const input = toClaudeInput(context.messages);
				const workdir = cwd;
				const { prompt, images } = buildAntigravityPrompt(input, (index, ext) => join(workdir, `input-${index}.${ext}`));
				// Backstop: agy would silently cut the newest turns past its cap.
				const bytes = Buffer.byteLength(prompt);
				if (bytes > AGY_MAX_INPUT_BYTES) throw new Error(antigravityTooLargeMessage(bytes));
				for (const image of images) await writeFile(image.path, Buffer.from(image.data, "base64"), { mode: 0o600 });
				const settings = { ...AGY_SESSION_SETTINGS, permissions: { ...AGY_SESSION_SETTINGS.permissions,
					deny: [...AGY_SESSION_SETTINGS.permissions.deny, ...(images.length ? [] : ["read_file(*)"])],
					allow: images.length ? [`read_file(${cwd}/)`] : [],
				} };
				const promptFile = join(cwd, "request.txt");
				await writeFile(promptFile, prompt, { mode: 0o600 });
				const argsFor = (modelId: string, effort: string | null | undefined) => ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
					"--settings", JSON.stringify(settings), "--json-schema", JSON.stringify(actionSchema(input.tools)), "--print-timeout", "5m",
					...(modelId === "default" ? [] : ["--model", modelId]),
					...(effort ? ["--effort", effort] : []),
				];
				// Pi has already clamped reasoning to this model's supported levels.
				const args = argsFor(model.id, options.reasoning && model.thinkingLevelMap?.[options.reasoning]);
				const fallbackMap = ANTIGRAVITY_MODELS.find((m) => m.id === ANTIGRAVITY_FALLBACK_MODEL)?.thinkingLevelMap;
				const fallbackLevel = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
				const fallbackArgs = argsFor(ANTIGRAVITY_FALLBACK_MODEL, fallbackLevel && fallbackMap?.[fallbackLevel]);
				if (options.signal?.aborted) throw new Error("Request was aborted");
				const env = externalCliEnv();
				// Use the CLI's saved account; never select API-key/ADC auth from the app environment.
				for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[name];
				options.signal?.addEventListener("abort", abort, { once: true });
				stream.push({ type: "start", partial: message });
				const attempt = (runArgs: string[]) => new Promise<Record<string, unknown>>((resolve, reject) => {
					child = run(binary, runArgs,{ cwd: workdir, env });
					let stdout = "", stderr = "";
					child!.stdout.setEncoding("utf8").on("data", (chunk: string) => {
						stdout += chunk;
						if (stdout.length > 16 * 1024 * 1024) { abort(); reject(new Error("Antigravity output exceeded 16 MiB.")); }
					});
					child!.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
					child!.once("error", reject);
					child!.stdin.on("error", reject);
					child!.once("close", (code) => {
						if (options.signal?.aborted) return reject(new Error("Request was aborted"));
						try {
							const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
							const result = events.findLast((e) => e.event === "result")?.result as Record<string, unknown> | undefined;
							if (code !== 0 || !result || result.status !== "SUCCESS") throw new Error(typeof result?.error === "string" ? result.error : stderr || "Antigravity ended without a successful result.");
							resolve(result);
						} catch (error) { reject(error); }
					});
					child!.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
				});
				const unusable = (e: Record<string, unknown>) => e.structured_output == null || inventedTurns(e.response);
				let envelope = await attempt(args);
				// A run is unusable for two reasons: Gemini sometimes writes its answer
				// as prose and never calls agy's finish tool (worst when the prose runs
				// into the print timeout; agy still reports SUCCESS, just without
				// structured output), or its prose invents transcript turns ("[user]",
				// "[tool result ...]"). One retry with the same request goes to the
				// fallback model, Claude Sonnet 5.5, recorded as the message's model.
				if (unusable(envelope)) {
					if (options.signal?.aborted) throw new Error("Request was aborted");
					envelope = await attempt(fallbackArgs);
					if (unusable(envelope)) throw new Error(ANTIGRAVITY_NO_ANSWER);
					message.model = ANTIGRAVITY_FALLBACK_MODEL;
				}
				const actions = parseActions(envelope.structured_output, input.tools);
				const usage = envelope.usage as Record<string, number> | undefined;
				const count = (key: string) => Math.max(0, Number.isFinite(usage?.[key]) ? usage![key]! : 0);
				message.usage.input = Math.max(0, count("input_tokens") - count("cache_read_tokens"));
				message.usage.output = count("output_tokens");
				message.usage.cacheRead = count("cache_read_tokens");
				message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead;
				if (actions.text) {
					const contentIndex = message.content.length;
					message.content.push({ type: "text", text: actions.text });
					stream.push({ type: "text_start", contentIndex, partial: message });
					stream.push({ type: "text_delta", contentIndex, delta: actions.text, partial: message });
					stream.push({ type: "text_end", contentIndex, content: actions.text, partial: message });
				}
				for (const call of actions.toolCalls) {
					const contentIndex = message.content.length;
					const toolCall = { type: "toolCall" as const, id: randomUUID(), ...call };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
				}
				message.stopReason = actions.toolCalls.length ? "toolUse" : "stop";
				terminal = { type: "done", reason: message.stopReason, message };
			} catch (error) {
				message.stopReason = options.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				terminal = { type: "error", reason: message.stopReason, error: message };
			} finally {
				options.signal?.removeEventListener("abort", abort);
				if (killTimer) clearTimeout(killTimer);
				if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
				if (terminal) stream.push(terminal);
				stream.end();
			}
		})();
		return stream;
	};
}

export const streamAntigravity = createAntigravityStream();
