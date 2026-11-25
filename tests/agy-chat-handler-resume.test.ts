import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-handler-resume-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AGY_BINARY = process.execPath;

const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const {
	fingerprint,
	removeWorkspace,
	writeLink,
} = await import("../src/agent/antigravity/link.ts");
const {
	AGY_COMPACT_AT_BYTES,
	projectedAntigravityRequestBytes,
} = await import("../src/agent/antigravity/request.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const {
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
} = await import("../src/agent/teacher-agent.ts");
const { backgroundCompactionDeps } = await import("../src/server/chat-handler.ts");
const { getPluginAgentContributions, initializePlugins } = await import("../src/server/plugins.ts");
const { effectiveSettings, stores } = await import("../src/server/stores.ts");
const { searchAvailable } = await import("../src/server/search.ts");
const { graphToolsEnabled } = await import("../src/core/settings-resolution.ts");
const { ANTIGRAVITY_PROVIDER } = await import("../src/core/contracts/antigravity.ts");
const { newUserMessage, toLlmMessages } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";

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
			// Best-effort cleanup.
		}
	}
});

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const HYDROGEN_MODEL = "gemini-4-hydrogen";
const SONNET_MODEL = "claude-sonnet-5-5";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantMsg(id: string, text: string, totalTokens: number, model: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "antigravity-cli",
		provider: ANTIGRAVITY_PROVIDER,
		model,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: Math.max(0, totalTokens - 100),
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: ZERO_COST,
		},
	} as unknown as LhMessage;
}

function probeDoneMessages(): LhMessage[] {
	return [
		{
			id: "m-probe-call",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-probe", name: "probe_done", arguments: { assessment: "solid" } }],
			api: "antigravity-cli",
			provider: ANTIGRAVITY_PROVIDER,
			model: HYDROGEN_MODEL,
			stopReason: "toolUse",
			timestamp: 1,
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: ZERO_COST },
		} as unknown as LhMessage,
		{
			id: "m-probe-res",
			role: "toolResult",
			toolCallId: "call-probe",
			toolName: "probe_done",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		} as unknown as LhMessage,
	];
}

function agentShapeFor(
	chatId: string,
	kind: "prober" | "teacher" | "practice",
	model: string,
	pluginContributions?: Awaited<ReturnType<typeof getPluginAgentContributions>>,
) {
	const engine = piEngineForSpec({ provider: ANTIGRAVITY_PROVIDER, id: model }, true);
	const effective = effectiveSettings();
	const opts = {
		chatId,
		engine,
		pluginContributions,
		toolToggles: effective.agent.tools,
		promptSwitches: effective.agent.prompts,
	};
	const graphOn = graphToolsEnabled(effective);
	const agent =
		kind === "practice"
			? createPracticeAgent(
					{
						chatId,
						chatStore,
						graphNodes: () => [],
						jobs: { chatId, jobStore, spawn: () => undefined, searchAvailable },
						...(graphOn ? { graph: { chatStore, graphStore: stores.graphStore } } : {}),
					},
					opts,
				)
			: kind === "teacher"
				? createTeacherAgent(
						{
							chatId,
							chatStore,
							jobStore,
							spawn: () => undefined,
							searchAvailable,
							breaks: () => effective.breaks,
							now: Date.now,
						},
						opts,
					)
				: createProberAgent(
						{
							chatId,
							chatStore,
							deliver: () => undefined,
							jobStore,
							spawn: () => undefined,
							searchAvailable,
							...(graphOn ? { graphStore: stores.graphStore } : {}),
						},
						opts,
					);
	return { systemPrompt: agent.state.systemPrompt, tools: agent.state.tools };
}

function saveResumableChat(
	label: string,
	kind: "prober" | "teacher" | "practice",
	model: string,
	pluginContributions?: Awaited<ReturnType<typeof getPluginAgentContributions>>,
) {
	const chat = chatStore.createChat(label, kind === "practice" ? "practice" : undefined);
	const chatId = trackChat(chat.id);
	chatStore.saveSettings(chatId, { model: { provider: ANTIGRAVITY_PROVIDER, id: model } });
	const prefix = kind === "teacher" ? probeDoneMessages() : [];
	const u1 = newUserMessage("u1 " + "x".repeat(73_000));
	const a1 = assistantMsg("a1", "a1 " + "y".repeat(73_000), 45_000, model);
	const messages = [...prefix, u1, a1];
	chatStore.saveMessages(chatId, messages);
	const { systemPrompt, tools } = agentShapeFor(chatId, kind, model, pluginContributions);
	assert.ok(projectedAntigravityRequestBytes(toLlmMessages(messages as readonly AgentMessage[]), systemPrompt) > AGY_COMPACT_AT_BYTES);
	const llm = toLlmMessages(messages as readonly AgentMessage[]);
	const sent = llm.length - 1;
	writeLink(chatId, {
		conversationId: `conv-${chatId}`,
		model,
		messageCount: sent,
		fingerprint: fingerprint(systemPrompt, tools, llm.slice(0, sent)),
	});
	return { chatId, messages };
}

describe("chat-handler antigravity resume-aware compaction gate", () => {
	it("treats unknown tools before plugins initialize and explicit unknownTools as a full replay", async () => {
		settingsStore.writeSettings({
			version: 1,
			antigravity: { enabled: true },
			models: { strong: { model: { provider: ANTIGRAVITY_PROVIDER, id: HYDROGEN_MODEL } } },
		});
		const { chatId, messages } = saveResumableChat("before-plugins", "prober", HYDROGEN_MODEL);

		const beforeInit = backgroundCompactionDeps(chatId);
		assert.ok(beforeInit);
		assert.equal(beforeInit.requestOverLimit!(messages), true);
		assert.notEqual(beforeInit.keptTail!(messages), undefined);

		await initializePlugins();
		const contributions = await getPluginAgentContributions();
		const withPlugins = saveResumableChat("with-plugins", "prober", HYDROGEN_MODEL, contributions);

		const unknownToolsDeps = backgroundCompactionDeps(withPlugins.chatId, { pluginContributions: contributions, unknownTools: true });
		assert.ok(unknownToolsDeps);
		assert.equal(unknownToolsDeps.requestOverLimit!(withPlugins.messages), true);
		assert.notEqual(unknownToolsDeps.keptTail!(withPlugins.messages), undefined);
	});

	it("skips byte-rule compaction on resumable prober, teacher, claude-sonnet, and practice chats at 170 KB / 45k tokens", async () => {
		settingsStore.writeSettings({
			version: 1,
			antigravity: { enabled: true },
			models: { strong: { model: { provider: ANTIGRAVITY_PROVIDER, id: HYDROGEN_MODEL } } },
		});
		await initializePlugins();
		const contributions = await getPluginAgentContributions();

		for (const [kind, model] of [
			["prober", HYDROGEN_MODEL],
			["teacher", HYDROGEN_MODEL],
			["teacher", SONNET_MODEL],
			["practice", HYDROGEN_MODEL],
		] as const) {
			const { chatId, messages } = saveResumableChat(`${kind}-${model}`, kind, model, contributions);
			const deps = backgroundCompactionDeps(chatId);
			assert.ok(deps, `${kind}/${model}: expected deps`);
			assert.equal(deps.requestOverLimit!(messages), false, `${kind}/${model}: resumable chat must not trigger 160 KB byte rule`);
			assert.equal(deps.keptTail!(messages), undefined, `${kind}/${model}: resumable chat must use token tail`);
		}
	});

	it("falls back to the byte rule when the selected model changes", async () => {
		settingsStore.writeSettings({
			version: 1,
			antigravity: { enabled: true },
			models: { strong: { model: { provider: ANTIGRAVITY_PROVIDER, id: HYDROGEN_MODEL } } },
		});
		await initializePlugins();
		const contributions = await getPluginAgentContributions();
		const { chatId, messages } = saveResumableChat("model-changed", "teacher", HYDROGEN_MODEL, contributions);

		chatStore.saveSettings(chatId, { model: { provider: ANTIGRAVITY_PROVIDER, id: SONNET_MODEL } });
		const deps = backgroundCompactionDeps(chatId);
		assert.ok(deps);
		assert.equal(deps.requestOverLimit!(messages), true);
		assert.notEqual(deps.keptTail!(messages), undefined);
	});
});
