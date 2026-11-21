import React, { type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Usage } from "@earendil-works/pi-ai";
import {
	AppRouterContext,
	type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { newUserMessage, type LhMessage, type PlanTree } from "../src/core/index.ts";
import type { CompactionDeps } from "../src/server/compaction.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-unit-cut-banner-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { compactionInFlight, ensureCompacted, runningUnit } = await import("../src/server/compaction.ts");
const { default: ChatPage } = await import("../app/chat/[id]/page.tsx");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const ROUTER: AppRouterInstance = {
	bfcacheId: "",
	back() {},
	forward() {},
	refresh() {},
	push() {},
	replace() {},
	prefetch() {},
};

const ZERO_USAGE: Usage = {
	input: 120,
	output: 40,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 160,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function renderChat(node: ReactNode): string {
	return renderToStaticMarkup(
		<AppRouterContext.Provider value={ROUTER}>
			<InteractionLayersProvider>
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					{node}
				</ServerEventsProvider>
			</InteractionLayersProvider>
		</AppRouterContext.Provider>,
	);
}

function twoUnitTree(): PlanTree {
	return {
		version: 1,
		nodes: [
			{ id: "n1", title: "Node One" },
			{ id: "n2", title: "Node Two" },
		],
		edges: [{ from: "n1", to: "n2" }],
		units: [
			{ id: "u1", title: "Foundations", nodeIds: ["n1"] },
			{ id: "u2", title: "Applications", nodeIds: ["n2"] },
		],
	};
}

function assistantTeachCall(id: string, callId: string, nodeId: string, text = "Let's check."): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { nodeId, question: "Q?" } },
		],
		timestamp: 1,
	} as never;
}

function toolResultFor(id: string, callId: string, text = "correct"): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text }],
		details: {
			kind: "quiz",
			questionText: "Q?",
			dontKnow: false,
			answers: [],
			correct: true,
			answeredAt: "2026-11-20T00:00:00.000Z",
		},
		isError: false,
		timestamp: 2,
	} as never;
}

describe("Chat initial unit-cut running banner", () => {
	it("starts with SUMMARIZING UNIT <n>… when mounted while a unit cut runs", () => {
		const html = renderChat(
			<Chat
				chatId="c_unit"
				title="Unit lesson"
				initialMessages={[]}
				initiallyCompacting={true}
				initiallyCompactingUnit={2}
			/>,
		);
		assert.ok(html.includes("SUMMARIZING UNIT 2…"));
		assert.ok(html.includes('aria-label="Summarizing unit 2"'));
		assert.ok(!html.includes("COMPACTING CONTEXT…"));
	});

	it("starts with COMPACTING CONTEXT… for an ordinary compaction without a running unit", () => {
		const html = renderChat(
			<Chat
				chatId="c_ordinary"
				title="Ordinary compaction"
				initialMessages={[]}
				initiallyCompacting={true}
			/>,
		);
		assert.ok(html.includes("COMPACTING CONTEXT…"));
		assert.ok(html.includes('aria-label="Compacting context"'));
		assert.ok(!html.includes("SUMMARIZING UNIT"));
	});

	it("renders no compaction banner when initiallyCompacting is false even if a unit prop is passed", () => {
		const html = renderChat(
			<Chat
				chatId="c_idle"
				title="Idle lesson"
				initialMessages={[]}
				initiallyCompacting={false}
				initiallyCompactingUnit={2}
			/>,
		);
		assert.ok(!html.includes("SUMMARIZING UNIT"));
		assert.ok(!html.includes("COMPACTING CONTEXT…"));
	});

	it("ChatPage seeds Chat from runningUnit(chatId) while a unit cut is in flight", async () => {
		const chat = chatStore.createChat("In-flight unit cut");
		chatStore.saveTree(chat.id, twoUnitTree());
		chatStore.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			toolResultFor("r1", "c1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseSummary!: (summary: string) => void;
		const summaryGate = new Promise<string>((resolve) => {
			releaseSummary = resolve;
		});

		const deps: CompactionDeps = {
			chatStore,
			engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
			modelId: "faux:test",
			kind: "teach",
			thresholdTokens: 500_000,
			systemPromptTokens: 100,
			summarize: async () => {
				markStarted();
				const summary = await summaryGate;
				return { summary, usage: ZERO_USAGE };
			},
		};

		const compactionRun = ensureCompacted(deps, chat.id);
		await started;

		assert.equal(compactionInFlight(chat.id), true);
		assert.equal(runningUnit(chat.id), 2);

		const page = await ChatPage({
			params: Promise.resolve({ id: chat.id }),
			searchParams: Promise.resolve({}),
		});
		const props = page.props as { initiallyCompacting?: boolean; initiallyCompactingUnit?: number };
		assert.equal(props.initiallyCompacting, true);
		assert.equal(props.initiallyCompactingUnit, 2);

		const runningHtml = renderChat(page);
		assert.ok(runningHtml.includes("SUMMARIZING UNIT 2…"));
		assert.ok(runningHtml.includes('aria-label="Summarizing unit 2"'));
		assert.ok(!runningHtml.includes("COMPACTING CONTEXT…"));

		releaseSummary(
			JSON.stringify({
				learnerWide: "Understands unit 1.",
				commitments: "",
				nodes: {
					n1: { learned: "Solid.", errorsCorrected: "", openPoints: "" },
				},
			}),
		);
		await compactionRun;

		assert.equal(compactionInFlight(chat.id), false);
		assert.equal(runningUnit(chat.id), undefined);

		const idlePage = await ChatPage({
			params: Promise.resolve({ id: chat.id }),
			searchParams: Promise.resolve({}),
		});
		const idleProps = idlePage.props as { initiallyCompacting?: boolean; initiallyCompactingUnit?: number };
		assert.equal(idleProps.initiallyCompacting, false);
		assert.equal(idleProps.initiallyCompactingUnit, undefined);

		const idleHtml = renderChat(idlePage);
		assert.ok(!idleHtml.includes("SUMMARIZING UNIT"));
		assert.ok(!idleHtml.includes("COMPACTING CONTEXT…"));
	});
});
