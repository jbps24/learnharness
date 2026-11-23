import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CURRENT_CHAT_VERSION,
	newUserMessage,
	parseChatInput,
	REPLY_RETRY_READ_ONLY_TOOLS,
	retryableReply,
	type ChatRecord,
	type LhMarkerMessage,
	type LhMessage,
	type RetiredReply,
} from "../src/core/index.ts";

const userMsg = (id: string, text = "hello"): LhMessage =>
	({ ...newUserMessage(text), id }) as LhMessage;

const assistantText = (
	id: string,
	stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
	text = "Here is an explanation.",
): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		timestamp: 1,
	}) as never;

const assistantWithCall = (
	id: string,
	callId: string,
	toolName: string,
	stopReason: "stop" | "toolUse" | "error" | "aborted" = "toolUse",
	text = "",
): LhMessage =>
	({
		id,
		role: "assistant",
		content: [
			...(text ? [{ type: "text", text }] : []),
			{ type: "toolCall", id: callId, name: toolName, arguments: {} },
		],
		stopReason,
		timestamp: 1,
	}) as never;

const toolResultMsg = (id: string, callId: string, toolName: string): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	}) as never;

const markerMsg = (id: string, customType: LhMarkerMessage["customType"]): LhMessage =>
	({
		id,
		role: "custom",
		customType,
		content: "",
		display: false,
		details: {},
		timestamp: 3,
	}) as LhMessage;

describe("retry-reply core (plan 006 part 1)", () => {
	// plan 006 part 1: parseChatInput({ type: "retry-reply" }) -> { type: "retry-reply" }
	it("parses retry-reply input event", () => {
		assert.deepEqual(parseChatInput({ type: "retry-reply" }), { type: "retry-reply" });
	});

	// plan 006 part 1: REPLY_RETRY_READ_ONLY_TOOLS constant lists the exact 15 read-only tools
	it("exports REPLY_RETRY_READ_ONLY_TOOLS with the exact read-only tool list", () => {
		assert.deepEqual(REPLY_RETRY_READ_ONLY_TOOLS, [
			"find",
			"find_candidates",
			"grep",
			"list_propositions",
			"list_sessions",
			"ls",
			"pdf",
			"pdf_extract",
			"pdf_info",
			"pdf_search",
			"read",
			"show_image",
			"web_fetch",
			"web_fetch_pdf",
			"web_search",
		]);
	});

	// plan 006 part 1: ChatRecord gains retiredReplies?: RetiredReply[] and no record version bump
	it("retains CURRENT_CHAT_VERSION at 2 and types RetiredReply on ChatRecord", () => {
		assert.equal(CURRENT_CHAT_VERSION, 2);
		const retired: RetiredReply = {
			at: "2026-11-22T00:00:00.000Z",
			messages: [assistantText("a1", "stop")],
		};
		const record: ChatRecord = {
			id: "chat-1",
			title: "Test",
			createdAt: "2026-11-22T00:00:00.000Z",
			updatedAt: "2026-11-22T00:00:00.000Z",
			messages: [userMsg("u1")],
			retiredReplies: [retired],
		};
		assert.equal(record.retiredReplies?.length, 1);
	});

	// plan 006 part 1: Text input, then an assistant with text only (stop) -> its id
	it("returns assistant id for text input followed by text-only assistant", () => {
		const msgs = [userMsg("u1", "Explain eigenvalues"), assistantText("a1", "stop")];
		assert.deepEqual(retryableReply(msgs), ["a1"]);
	});

	// plan 006 part 1: explain answer (toolResult, toolName: "explain"), break-note, then assistant with text only -> assistant id (break-note stays out)
	it("skips break-note between explain toolResult and assistant (Regelungssysteme shape)", () => {
		const msgs = [
			toolResultMsg("r1", "c1", "explain"),
			markerMsg("m1", "break-note"),
			assistantText("a1", "stop"),
		];
		assert.deepEqual(retryableReply(msgs), ["a1"]);
	});

	// plan 006 part 1: user, assistant calling pdf (toolUse), toolResult pdf, then assistant text + explain call with no result (toolUse) -> three ids in order
	it("collects read-only tool call, its result, and trailing assistant with question call in record order", () => {
		const msgs = [
			userMsg("u1"),
			assistantWithCall("a1", "c_pdf", "pdf", "toolUse"),
			toolResultMsg("r_pdf", "c_pdf", "pdf"),
			assistantWithCall("a2", "c_exp", "explain", "toolUse", "What do you think?"),
		];
		assert.deepEqual(retryableReply(msgs), ["a1", "r_pdf", "a2"]);
	});

	// plan 006 part 1: A side-question marker after the reply -> still retryable, marker id not returned
	it("skips side-question markers after the reply", () => {
		const msgs = [
			userMsg("u1"),
			assistantText("a1", "stop"),
			markerMsg("sq1", "side-question"),
			markerMsg("sq2", "side-question-told"),
		];
		assert.deepEqual(retryableReply(msgs), ["a1"]);
	});

	// plan 006 part 1: user, a course-files note and a course-method note (plan 007), then an assistant with text only -> assistant id (both notes stay out)
	it("skips course-files and course-method notes between input and reply", () => {
		const msgs = [
			userMsg("u1"),
			markerMsg("cf1", "course-files"),
			markerMsg("cm1", "course-method"),
			assistantText("a1", "stop"),
		];
		assert.deepEqual(retryableReply(msgs), ["a1"]);
	});

	// plan 006 part 1: custom messages graph-context and units-note are skipped (stays, not collected)
	it("skips graph-context and units-note markers", () => {
		const msgs = [
			userMsg("u1"),
			markerMsg("gc1", "graph-context"),
			markerMsg("un1", "units-note"),
			assistantText("a1", "stop"),
		];
		assert.deepEqual(retryableReply(msgs), ["a1"]);
	});

	// plan 006 part 1: input is a toolResult whose toolName is in QUESTION_TOOLS
	it("accepts any QUESTION_TOOLS toolResult as input", () => {
		for (const tool of ["quiz", "probe", "ask_user_question", "explain", "recall"] as const) {
			const msgs = [toolResultMsg("r1", "c1", tool), assistantText("a1", "stop")];
			assert.deepEqual(retryableReply(msgs), ["a1"], `expected ${tool} toolResult to be a valid input`);
		}
	});

	// plan 006 part 1: Not retryable (null): an empty record
	it("returns null for an empty record", () => {
		assert.equal(retryableReply([]), null);
	});

	// plan 006 part 1: Not retryable (null): the last message is a user
	it("returns null when the last message is a user message", () => {
		assert.equal(retryableReply([userMsg("u1")]), null);
	});

	// plan 006 part 1: Not retryable (null): the last assistant has stopReason "error" or "aborted"
	it("returns null when the last assistant has stopReason error or aborted", () => {
		assert.equal(retryableReply([userMsg("u1"), assistantText("a1", "error")]), null);
		assert.equal(retryableReply([userMsg("u1"), assistantText("a1", "aborted")]), null);
	});

	// plan 006 part 1: Not retryable (null): reply calls demo (with toolResult), suggest_break, plan_init, conclude, or probe_done
	it("returns null when the reply calls a non-read-only, non-question tool", () => {
		const withDemoResult = [
			userMsg("u1"),
			assistantWithCall("a1", "c1", "demo", "toolUse"),
			toolResultMsg("r1", "c1", "demo"),
			assistantText("a2", "stop"),
		];
		assert.equal(retryableReply(withDemoResult), null);

		for (const tool of ["suggest_break", "plan_init", "conclude", "probe_done"] as const) {
			const msgs = [userMsg("u1"), assistantWithCall("a1", "c1", tool, "toolUse")];
			assert.equal(retryableReply(msgs), null, `expected ${tool} call to make reply non-retryable`);
		}
	});

	// plan 006 part 1: Not retryable (null): a compaction or lesson-record or plan-block marker between input and reply
	it("returns null when compaction, lesson-record, or plan-block sits between input and reply", () => {
		for (const marker of ["compaction", "lesson-record", "plan-block"] as const) {
			const msgs = [userMsg("u1"), markerMsg("m1", marker), assistantText("a1", "stop")];
			assert.equal(retryableReply(msgs), null, `expected ${marker} marker to stop the walk`);
		}
	});

	// plan 006 part 1: Not retryable (null): the input is a subagent-steer custom message
	it("returns null when the input is a subagent-steer custom message", () => {
		const msgs = [markerMsg("s1", "subagent-steer"), assistantText("a1", "stop")];
		assert.equal(retryableReply(msgs), null);
	});

	// plan 006 scope rules: replies to break-continue are out of scope
	it("returns null when the input is a break-ended custom message", () => {
		const msgs = [markerMsg("b1", "break-ended"), assistantText("a1", "stop")];
		assert.equal(retryableReply(msgs), null);
	});

	// plan 006 part 1: the input must exist (a reply with no input before it is not retryable)
	it("returns null when no input precedes the reply", () => {
		assert.equal(retryableReply([assistantText("a1", "stop")]), null);
		assert.equal(retryableReply([markerMsg("m1", "break-note"), assistantText("a1", "stop")]), null);
	});

	// plan 006 part 1: at least one assistant must be collected
	it("returns null when nothing but tool results or skipped notes follow the input", () => {
		assert.equal(retryableReply([userMsg("u1"), toolResultMsg("r1", "c1", "pdf")]), null);
		assert.equal(retryableReply([userMsg("u1"), markerMsg("m1", "break-note")]), null);
	});

	// plan 006 part 1: every collected assistant has stopReason stop or toolUse
	it("returns null when an earlier collected assistant errored or aborted", () => {
		for (const bad of ["error", "aborted"] as const) {
			const msgs = [
				userMsg("u1"),
				assistantWithCall("a1", "c1", "pdf", bad),
				toolResultMsg("r1", "c1", "pdf"),
				assistantText("a2", "stop"),
			];
			assert.equal(retryableReply(msgs), null, `expected earlier ${bad} assistant to block`);
		}
	});

	// plan 006 part 1: every collected toolResult has a toolName in REPLY_RETRY_READ_ONLY_TOOLS
	it("returns null when a collected toolResult is not read-only, even without a disallowed call", () => {
		const msgs = [userMsg("u1"), toolResultMsg("r1", "c1", "demo"), assistantText("a1", "stop")];
		assert.equal(retryableReply(msgs), null);
	});

	// plan 006 part 1: Not retryable (null): the input is a toolResult of demo
	it("returns null when the input is a toolResult of demo", () => {
		const msgs = [toolResultMsg("r1", "c1", "demo"), assistantText("a1", "stop")];
		assert.equal(retryableReply(msgs), null);
	});
});
