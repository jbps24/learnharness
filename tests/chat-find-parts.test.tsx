import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { findUnits, projectView, type LhMessage } from "../src/core/index.ts";

const ROUTER: AppRouterInstance = {
	bfcacheId: "",
	back() {},
	forward() {},
	refresh() {},
	push() {},
	replace() {},
	prefetch() {},
};

const assistantText = (id: string, text: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 2 }) as never;

function renderChat(messages: LhMessage[]): string {
	return renderToStaticMarkup(
		<AppRouterContext.Provider value={ROUTER}>
			<InteractionLayersProvider>
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					<Chat chatId="c_find_parts" title="Find parts" initialMessages={messages} />
				</ServerEventsProvider>
			</InteractionLayersProvider>
		</AppRouterContext.Provider>,
	);
}

describe("Chat find-part keys", () => {
	// plan 003 part 5 §8: a teacher text part carries the same data-find-part key findUnits produces
	it("marks a teacher text part with its findUnits key, not the source message id", () => {
		const messages = [assistantText("m1", "Gradient descent explained")];
		const units = findUnits({ native: messages, view: projectView(messages), sideThreads: [], pendingQuestionVisible: false });
		const key = units.find((unit) => unit.kind === "Teacher")?.key;
		assert.ok(key && key !== "m1", "the text part key differs from the message id");
		const html = renderChat(messages);
		assert.ok(html.includes(`data-find-part="${key}"`), `expected data-find-part="${key}"`);
		assert.ok(!html.includes('data-find-part="m1"'), "no message-level key on the part");
	});

	const call = (id: string, name: string, args: Record<string, unknown>, callId: string): LhMessage =>
		({ id, role: "assistant", content: [{ type: "text", text: "Intro" }, { type: "toolCall", id: callId, name, arguments: args }], timestamp: 2 }) as never;
	const result = (id: string, callId: string, name: string, details: unknown): LhMessage =>
		({ id, role: "toolResult", toolCallId: callId, toolName: name, content: [], isError: false, details, timestamp: 3 }) as never;
	const keyOf = (messages: LhMessage[], kind: string, pendingQuestionVisible = false): string | undefined =>
		findUnits({ native: messages, view: projectView(messages), sideThreads: [], pendingQuestionVisible }).find((unit) => unit.kind === kind)?.key;

	it("marks the built-in Problem and Solution with their findUnits keys", () => {
		const messages = [
			call("mp", "problem", { statement: "Integrate x squared" }, "cp"),
			result("rp", "cp", "problem", null),
			call("mc", "conclude", { outcome: "solved", verdict: "Correct", feedback: "Well done", solutionReveal: "x cubed over three" }, "cc"),
			result("rc", "cc", "conclude", { ok: true }),
		];
		const problem = keyOf(messages, "Problem");
		const solution = keyOf(messages, "Solution");
		assert.equal(problem, "mp:1");
		assert.equal(solution, "mc:1");
		const html = renderChat(messages);
		assert.ok(html.includes(`data-find-part="${problem}"`), "problem key");
		assert.ok(html.includes(`data-find-part="${solution}"`), "solution key");
	});

	it("marks the sub-agent delivery with its findUnits key", () => {
		const messages = [
			{ id: "m_ss1", role: "custom", customType: "subagent-steer", content: "sa", display: true, details: { kind: "pdf", result: { title: "doc", brief: "Brief text", pagesRead: [1] } }, timestamp: 7 } as never,
		] as LhMessage[];
		const artifact = projectView(messages).flatMap((m) => m.parts).find((p) => p.type === "data-subagent-artifact");
		assert.ok(artifact?.id, "the view carries the artifact part");
		assert.ok(renderChat(messages).includes(`data-find-part="${artifact.id}"`));
	});

	it("marks the pending dock question with the dock key", () => {
		const messages = [call("mq", "ask_user_question", { question: "What is a gradient?" }, "cq")];
		assert.equal(keyOf(messages, "Question", true), "dock");
		assert.ok(renderChat(messages).includes('data-find-part="dock"'));
	});
});
