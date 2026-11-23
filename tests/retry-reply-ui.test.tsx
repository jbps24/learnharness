import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { Chat, retryLatestReply } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { newUserMessage, type ChatInput, type LhMessage } from "../src/core/index.ts";

const assistantReply = (
	id: string,
	content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
	stopReason: "stop" | "toolUse" = "stop",
): LhMessage =>
	({
		id,
		role: "assistant",
		content,
		stopReason,
		timestamp: 2,
	}) as never;

const toolResultMsg = (id: string, toolCallId: string, toolName: string): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 3,
	}) as never;

const routerStub = {
	push() {},
	replace() {},
	refresh() {},
	back() {},
	forward() {},
	prefetch() {},
} as never;

function renderChat(props: {
	initialMessages: LhMessage[];
	initiallyInFlight?: boolean;
	kind?: "teach" | "practice";
	initialError?: string;
}) {
	const html = renderToStaticMarkup(
		<AppRouterContext.Provider value={routerStub}>
			<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
				<InteractionLayersProvider>
					<Chat
						chatId="chat_test"
						title="Lesson"
						initialMessages={props.initialMessages}
						initiallyInFlight={props.initiallyInFlight}
						kind={props.kind}
							initialError={props.initialError}
					/>
				</InteractionLayersProvider>
			</ServerEventsProvider>
		</AppRouterContext.Provider>,
	);
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

describe("retry-reply UI", () => {
	// plan 006 part 3: retryLatestReply(send, submittedDraft) sets submittedDraft.current = null and sends { type: "retry-reply" }.
	it("retryLatestReply clears the draft ref and sends { type: \"retry-reply\" }", () => {
		const sent: ChatInput[] = [];
		const submittedDraft: { current: string | null } = { current: "unsent draft" };
		retryLatestReply((input) => sent.push(input), submittedDraft);
		assert.equal(submittedDraft.current, null);
		assert.deepEqual(sent, [{ type: "retry-reply" }]);
	});

	// plan 006 part 3: the button shows for a record ending in a text-only reply (status ready).
	it("shows the Retry button for a teaching chat ending in a text-only reply", () => {
		const doc = renderChat({
			initialMessages: [
				newUserMessage("Explain derivatives"),
				assistantReply("a1", [{ type: "text", text: "A derivative measures rate of change." }], "stop"),
			],
		});
		const button = doc.querySelector('[data-testid="retry-reply"]');
		assert.ok(button);
		assert.match(button.textContent ?? "", /Retry/);
	});

	// plan 006 part 3: the button is absent when a turn is in flight.
	it("hides the Retry button when a turn is in flight", () => {
		const doc = renderChat({
			initialMessages: [
				newUserMessage("Explain derivatives"),
				assistantReply("a1", [{ type: "text", text: "A derivative measures rate of change." }], "stop"),
			],
			initiallyInFlight: true,
		});
		assert.equal(doc.querySelector('[data-testid="retry-reply"]'), null);
	});

	// plan 006 part 3: the button is absent while an error banner shows.
	it("hides the Retry button while an error banner is showing", () => {
		const doc = renderChat({
			initialMessages: [
				newUserMessage("Explain derivatives"),
				assistantReply("a1", [{ type: "text", text: "A derivative measures rate of change." }], "stop"),
			],
			initialError: "provider failed",
		});
		assert.ok(doc.body.textContent?.includes("provider failed"));
		assert.equal(doc.querySelector('[data-testid="retry-reply"]'), null);
	});

	// plan 006 part 3: the button is absent when the record ends in a user message.
	it("hides the Retry button when the record ends in a user message", () => {
		const doc = renderChat({
			initialMessages: [newUserMessage("Explain derivatives")],
		});
		assert.equal(doc.querySelector('[data-testid="retry-reply"]'), null);
	});

	// plan 006 part 3: the button is absent when the reply called demo.
	it("hides the Retry button when the reply called demo", () => {
		const doc = renderChat({
			initialMessages: [
				newUserMessage("Show me"),
				assistantReply("a1", [{ type: "toolCall", id: "call_1", name: "demo", arguments: {} }], "toolUse"),
				toolResultMsg("tr1", "call_1", "demo"),
				assistantReply("a2", [{ type: "text", text: "Here is the demo." }], "stop"),
			],
		});
		assert.equal(doc.querySelector('[data-testid="retry-reply"]'), null);
	});

	// plan 006 part 3: the button is absent in a practice chat.
	it("hides the Retry button in a practice chat", () => {
		const doc = renderChat({
			initialMessages: [
				newUserMessage("Explain derivatives"),
				assistantReply("a1", [{ type: "text", text: "A derivative measures rate of change." }], "stop"),
			],
			kind: "practice",
		});
		assert.equal(doc.querySelector('[data-testid="retry-reply"]'), null);
	});
});
