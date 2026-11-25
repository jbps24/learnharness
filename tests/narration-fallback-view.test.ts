/** Narration fallback view projection tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	OWED_NARRATION_PART_TYPE,
	projectView,
	type OwedNarrationData,
} from "../src/core/view.ts";
import { NARRATION_BLOCK_REASON, narrationBlockReason } from "../src/agent/narration-guard.ts";

const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string, text = "") => ({ type: "thinking", thinking: text, thinkingSignature: sig(type) });
const quiz = (id: string) => ({ type: "toolCall", id, name: "quiz", arguments: { question: "Next?" } });
const sendToUser = (message: string, id: string) => ({
	type: "toolCall", id, name: "send_to_user", arguments: { message },
});
const userMsg = (id: string, text: string): LhMessage => ({
	id,
	role: "user",
	content: text,
	timestamp: 1,
}) as LhMessage;
const assistantMsg = (id: string, ...content: unknown[]): LhMessage => ({
	id,
	role: "assistant",
	content,
	stopReason: "toolUse",
	timestamp: 2,
}) as unknown as LhMessage;
const toolResult = (id: string, toolCallId: string, toolName: string, text: string, isError = false): LhMessage => ({
	id,
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text }],
	isError,
	timestamp: 3,
}) as unknown as LhMessage;

const CASE_16_13_NARRATION =
	"Your answer for part (a) has the right setup, because the derivative of x^2 is 2x, " +
	"but you dropped the negative sign from the chain rule when differentiating cos(3x).";
const CASE_16_13_BRIDGE = "Let us try one more check.";

const CASE_16_01_NARRATION =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1.";
const CASE_16_01_FULL_GRADING =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1, so the series converges absolutely.";

describe("projectView narration fallback", () => {
	// plan 021 part 3: the view of the 16:13 sequence has the owed-narration part with the marker label before the question at 571
	it("has the owed-narration part with the marker label before the question at 571 on the 16:13 sequence", () => {
		const msg569 = assistantMsg("m569", thinking("narration", CASE_16_13_NARRATION), quiz("q569"));
		const rejection = narrationBlockReason(msg569 as never);
		const messages: LhMessage[] = [
			userMsg("u1", "My answer is 2x + 3sin(3x)."),
			msg569,
			toolResult("r569", "q569", "quiz", rejection, true),
			assistantMsg("m570", sendToUser(CASE_16_13_BRIDGE, "s570")),
			toolResult("r570", "s570", "send_to_user", "Message received for display.", false),
			assistantMsg("m571", quiz("q571")),
		];

		const view = projectView(messages);
		const assistant = view.find((m) => m.role === "assistant");
		assert.ok(assistant);

		const owedIdx = assistant.parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const quizIdx = assistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q571");
		assert.notEqual(owedIdx, -1);
		assert.notEqual(quizIdx, -1);
		assert.ok(owedIdx < quizIdx);

		const data = assistant.parts[owedIdx]!.data as OwedNarrationData | undefined;
		assert.equal(data?.text, CASE_16_13_NARRATION);
		assert.equal(data?.label, "Tutor's notes (not sent as a message)");
	});

	// plan 021 part 3: 16:01 has no owed-narration part when full grading was delivered
	it("has no owed-narration part on the 16:01 sequence when full grading was delivered", () => {
		const firstMsg = assistantMsg("m1", thinking("narration", CASE_16_01_NARRATION), quiz("q1"));
		const messages: LhMessage[] = [
			userMsg("u1", "It converges by the ratio test."),
			firstMsg,
			toolResult("r1", "q1", "quiz", narrationBlockReason(firstMsg as never), true),
			assistantMsg("m2", sendToUser(CASE_16_01_FULL_GRADING, "s1")),
			toolResult("r2", "s1", "send_to_user", "Message received for display.", false),
			assistantMsg("m3", quiz("q2")),
		];

		const view = projectView(messages);
		const owedParts = view.flatMap((m) => m.parts).filter((p) => p.type === OWED_NARRATION_PART_TYPE);
		assert.equal(owedParts.length, 0);
	});

	// plan 021 part 3: a chat without guard rejections renders unchanged
	it("renders a chat without guard rejections unchanged", () => {
		const messages: LhMessage[] = [
			userMsg("u1", "I am ready."),
			assistantMsg("m1", sendToUser("Let us check your understanding.", "s1"), quiz("q1")),
			toolResult("r1", "s1", "send_to_user", "Message received for display.", false),
		];

		const view = projectView(messages);
		assert.equal(view.length, 2);
		const assistant = view[1]!;
		assert.equal(assistant.role, "assistant");
		assert.deepEqual(
			assistant.parts.map((p) => p.type),
			["step-start", "text", "tool-quiz"],
		);
		assert.equal(assistant.parts[1]!.text, "Let us check your understanding.");
		assert.equal(assistant.parts[2]!.toolCallId, "q1");
	});

	// plan 021 part 3: an empty narration block leaves no owed narration in the view
	it("emits no owed-narration part when the rejected narration block had empty text", () => {
		const messages: LhMessage[] = [
			userMsg("u1", "Next?"),
			assistantMsg("m1", thinking("narration", ""), quiz("q1")),
			toolResult("r1", "q1", "quiz", NARRATION_BLOCK_REASON, true),
			assistantMsg("m2", quiz("q2")),
		];

		const view = projectView(messages);
		const owedParts = view.flatMap((m) => m.parts).filter((p) => p.type === OWED_NARRATION_PART_TYPE);
		assert.equal(owedParts.length, 0);
	});

	it("attaches the owed-narration part before the question rather than preceding non-question tool calls", () => {
		const m1 = assistantMsg("m1", thinking("narration", CASE_16_13_NARRATION), quiz("q1"));
		const messages: LhMessage[] = [
			userMsg("u1", "My answer is 2x + 3sin(3x)."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg(
				"m2",
				{ type: "toolCall", id: "p1", name: "plan_get", arguments: {} },
				sendToUser(CASE_16_13_BRIDGE, "s2"),
				quiz("q2"),
			),
			toolResult("r2", "p1", "plan_get", "ok", false),
			toolResult("r3", "s2", "send_to_user", "Message received for display.", false),
		];

		const view = projectView(messages);
		const assistant = view.find((m) => m.role === "assistant");
		assert.ok(assistant);

		const planIdx = assistant.parts.findIndex((p) => p.type === "tool-plan_get");
		const textIdx = assistant.parts.findIndex((p) => p.type === "text");
		const owedIdx = assistant.parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const quizIdx = assistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q2");
		assert.notEqual(planIdx, -1);
		assert.notEqual(textIdx, -1);
		assert.notEqual(owedIdx, -1);
		assert.notEqual(quizIdx, -1);
		assert.ok(planIdx < textIdx);
		assert.ok(textIdx < owedIdx);
		assert.ok(owedIdx < quizIdx);
	});

	it("skips rejected question calls when placing the owed-narration fallback across a two-block sequence", () => {
		const m1 = assistantMsg("m1", thinking("narration", CASE_16_13_NARRATION), quiz("q1"));
		const m2 = assistantMsg("m2", sendToUser(CASE_16_13_BRIDGE, "s2"), quiz("q2"));
		const messages: LhMessage[] = [
			userMsg("u1", "My answer is 2x + 3sin(3x)."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			m2,
			toolResult("r2", "s2", "send_to_user", "Message received for display.", false),
			toolResult("r3", "q2", "quiz", narrationBlockReason(m2 as never, CASE_16_13_NARRATION), true),
			assistantMsg("m3", quiz("q3")),
			toolResult("r4", "q3", "quiz", "2x - 3sin(3x)", false),
		];

		const view = projectView(messages);
		const assistant = view.find((m) => m.role === "assistant");
		assert.ok(assistant);

		const owedParts = assistant.parts.filter((p) => p.type === OWED_NARRATION_PART_TYPE);
		assert.equal(owedParts.length, 1);
		const q2Idx = assistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q2");
		const owedIdx = assistant.parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const q3Idx = assistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q3");
		assert.notEqual(q2Idx, -1);
		assert.notEqual(owedIdx, -1);
		assert.notEqual(q3Idx, -1);
		assert.ok(q2Idx < owedIdx);
		assert.ok(owedIdx < q3Idx);
		assert.equal((owedParts[0]!.data as OwedNarrationData | undefined)?.text, CASE_16_13_NARRATION);
	});

	it("skips errored question calls from live executions or earlier in the same message", () => {
		const m1 = assistantMsg("m1", thinking("narration", CASE_16_13_NARRATION), quiz("q1"));
		const liveMessages: LhMessage[] = [
			userMsg("u1", "My answer is 2x + 3sin(3x)."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg("m2", quiz("q2")),
			assistantMsg("m3", quiz("q3")),
		];
		const liveView = projectView(liveMessages, {
			executions: new Map([["q2", { isError: true, errorText: "blocked" }]]),
			inFlight: true,
			streamingIds: new Set(["m3"]),
		});
		const liveAssistant = liveView.find((m) => m.role === "assistant")!;
		const liveQ2Idx = liveAssistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q2");
		const liveOwedIdx = liveAssistant.parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const liveQ3Idx = liveAssistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q3");
		assert.ok(liveQ2Idx !== -1 && liveQ2Idx < liveOwedIdx && liveOwedIdx < liveQ3Idx);

		const sameMsgView = projectView([
			userMsg("u1", "My answer is 2x + 3sin(3x)."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg("m2", quiz("q2_err"), quiz("q2_ok")),
			toolResult("r2", "q2_err", "quiz", "rejected", true),
		]);
		const sameAssistant = sameMsgView.find((m) => m.role === "assistant")!;
		const errIdx = sameAssistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q2_err");
		const owedIdx = sameAssistant.parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const okIdx = sameAssistant.parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q2_ok");
		assert.ok(errIdx !== -1 && errIdx < owedIdx && owedIdx < okIdx);
	});

	it("clears owed narration when send_to_user in the same message precedes the question", () => {
		const m1 = assistantMsg("m1", thinking("narration", CASE_16_01_NARRATION), quiz("q1"));
		const settledMessages: LhMessage[] = [
			userMsg("u1", "It converges by the ratio test."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg("m2", sendToUser(CASE_16_01_FULL_GRADING, "s2"), quiz("q2")),
			toolResult("r2", "s2", "send_to_user", "Message received for display.", false),
		];
		assert.equal(projectView(settledMessages).flatMap((m) => m.parts).filter((p) => p.type === OWED_NARRATION_PART_TYPE).length, 0);

		const liveMessages: LhMessage[] = [
			userMsg("u1", "It converges by the ratio test."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg("m2", sendToUser(CASE_16_01_FULL_GRADING, "s2"), quiz("q2")),
		];
		const liveView = projectView(liveMessages, {
			executions: new Map([["s2", { isError: false, output: null }]]),
			inFlight: true,
			streamingIds: new Set(["m2"]),
		});
		assert.equal(liveView.flatMap((m) => m.parts).filter((p) => p.type === OWED_NARRATION_PART_TYPE).length, 0);
	});

	it("still emits owed narration when a preceding send_to_user in the same message failed", () => {
		const m1 = assistantMsg("m1", thinking("narration", CASE_16_01_NARRATION), quiz("q1"));
		const messages: LhMessage[] = [
			userMsg("u1", "It converges by the ratio test."),
			m1,
			toolResult("r1", "q1", "quiz", narrationBlockReason(m1 as never), true),
			assistantMsg("m2", sendToUser(CASE_16_01_FULL_GRADING, "s2"), quiz("q2")),
			toolResult("r2", "s2", "send_to_user", "Tool error", true),
		];
		const owedParts = projectView(messages).flatMap((m) => m.parts).filter((p) => p.type === OWED_NARRATION_PART_TYPE);
		assert.equal(owedParts.length, 1);
		assert.equal((owedParts[0]!.data as OwedNarrationData | undefined)?.text, CASE_16_01_NARRATION);
	});
});
