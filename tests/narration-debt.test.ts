/** Core narration-debt length rule and sequence scan tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isNarrationBlock,
	isNarrationDebtCleared,
	isNarrationRejection,
	owedNarration,
	owedNarrationState,
	type NarrationDebtMessage,
} from "../src/core/narration-debt.ts";
import { OWED_NARRATION_PART_TYPE, projectView } from "../src/core/view.ts";
import { NARRATION_BLOCK_REASON, narrationBlockReason } from "../src/agent/narration-guard.ts";

const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string, text = "") => ({ type: "thinking", thinking: text, thinkingSignature: sig(type) });
const quiz = (id = "q1") => ({ type: "toolCall", id, name: "quiz", arguments: {} });
const sendToUser = (message: string, id = "s1") => ({
	type: "toolCall", id, name: "send_to_user", arguments: { message },
});
const toolResult = (toolCallId: string, toolName: string, text: string, isError = false): NarrationDebtMessage => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text }],
	isError,
});

const CASE_16_13_NARRATION =
	"Your answer for part (a) has the right setup, because the derivative of x^2 is 2x, " +
	"but you dropped the negative sign from the chain rule when differentiating cos(3x).";
const CASE_16_13_BRIDGE = "Let us try one more check.";

const CASE_16_01_NARRATION =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1.";
const CASE_16_01_FULL_GRADING =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1, so the series converges absolutely.";
const OLD_NARRATION_BLOCK_REASON =
	"This response contains narration but no delivered learner-facing prose. Write the explanation or commentary the learner needs through `send_to_user`, then retry this question. Deliver learner-facing content, not internal reasoning.";

describe("isNarrationDebtCleared", () => {
	// plan 021 owner decision 2: block when send_to_user text delivered is shorter than hidden narration text
	it("returns false when delivered text is shorter than owed narration, and true when equal or longer", () => {
		assert.equal(isNarrationDebtCleared("12345", "1234"), false);
		assert.equal(isNarrationDebtCleared("12345", "12345"), true);
		assert.equal(isNarrationDebtCleared("12345", "123456"), true);
		assert.equal(isNarrationDebtCleared("", ""), true);
	});
});

describe("isNarrationRejection", () => {
	// plan 021 part 2: an old-wording rejection is recognized
	it("recognizes both new-wording and old-wording narration rejections", () => {
		const newWording = narrationBlockReason({
			role: "assistant",
			content: [thinking("narration", CASE_16_13_NARRATION), quiz()],
		} as never);
		assert.equal(isNarrationRejection(newWording), true);
		assert.equal(isNarrationRejection(NARRATION_BLOCK_REASON), true);
		assert.equal(isNarrationRejection(OLD_NARRATION_BLOCK_REASON), true);
		assert.equal(isNarrationRejection("Tool validation failed: missing argument."), false);
	});
});

describe("owedNarration", () => {
	// plan 021 part 2: on the stored 16:13 sequence it reports the owed narration before message 571
	it("reports owed narration on the 16:13 sequence before message 571 after a short bridge", () => {
		const msg569 = {
			role: "assistant",
			content: [thinking("narration", CASE_16_13_NARRATION), quiz("q569")],
		};
		const rejection = narrationBlockReason(msg569 as never);
		const sequenceBefore571: NarrationDebtMessage[] = [
			msg569,
			toolResult("q569", "quiz", rejection, true),
			{
				role: "assistant",
				content: [sendToUser(CASE_16_13_BRIDGE, "s570")],
			},
			toolResult("s570", "send_to_user", "Message received for display.", false),
		];
		assert.equal(owedNarration(sequenceBefore571), CASE_16_13_NARRATION);
	});

	// plan 021 part 2: on 16:01 it reports none
	it("reports no owed narration on the 16:01 sequence when full grading was delivered", () => {
		const firstMsg = {
			role: "assistant",
			content: [thinking("narration", CASE_16_01_NARRATION), quiz("q1")],
		};
		const sequence: NarrationDebtMessage[] = [
			firstMsg,
			toolResult("q1", "quiz", narrationBlockReason(firstMsg as never), true),
			{
				role: "assistant",
				content: [sendToUser(CASE_16_01_FULL_GRADING, "s1")],
			},
			toolResult("s1", "send_to_user", "Message received for display.", false),
		];
		assert.equal(owedNarration(sequence), undefined);
	});

	// plan 021 part 2: an old-wording rejection is recognized
	it("recognizes an old-wording narration rejection in the sequence", () => {
		const sequenceWithOldRejection: NarrationDebtMessage[] = [
			{
				role: "assistant",
				content: [thinking("narration", CASE_16_13_NARRATION), quiz("q1")],
			},
			toolResult("q1", "quiz", OLD_NARRATION_BLOCK_REASON, true),
		];
		assert.equal(owedNarration(sequenceWithOldRejection), CASE_16_13_NARRATION);
	});

	it("keeps original owed narration and resets delivered length on a subsequent rejection", () => {
		const n1 = "1234567890".repeat(4);
		const n2 = "Different shorter narration.";
		const bridge1 = "1234567890123456789012345";
		const bridge2 = "1234567890123456789012345";
		assert.ok(bridge1.length + bridge2.length >= n1.length);
		assert.ok(bridge2.length < n1.length);

		for (const secondThinking of [[], [thinking("narration", n2)]] as const) {
			const m1 = { role: "assistant", content: [thinking("narration", n1), quiz("q1")] };
			const m2 = { role: "assistant", content: [...secondThinking, sendToUser(bridge1, "s2"), quiz("q2")] };
			const seq: NarrationDebtMessage[] = [
				m1,
				toolResult("q1", "quiz", narrationBlockReason(m1 as never), true),
				m2,
				toolResult("s2", "send_to_user", "Message received for display.", false),
				toolResult("q2", "quiz", narrationBlockReason(m2 as never, n1), true),
				{ role: "assistant", content: [sendToUser(bridge2, "s3")] },
				toolResult("s3", "send_to_user", "Message received for display.", false),
			];
			assert.equal(owedNarration(seq), n1);
		}
	});

	it("resets owed and delivered at user, custom, and non-rejection question toolResult boundaries", () => {
		const n1 = "First run hidden narration that stays unpaid.";
		const n2 = "Second run hidden narration.";
		const m1 = { role: "assistant", content: [thinking("narration", n1), quiz("q1")] };
		const m2 = { role: "assistant", content: [thinking("narration", n2), quiz("q2")] };
		const baseRun1: NarrationDebtMessage[] = [
			m1,
			toolResult("q1", "quiz", narrationBlockReason(m1 as never), true),
			{ role: "assistant", content: [sendToUser("Partial", "s1")] },
			toolResult("s1", "send_to_user", "Message received for display.", false),
		];
		const nonQuestionResult = toolResult("r1", "read", "file contents", false);
		assert.deepEqual(owedNarrationState([...baseRun1, nonQuestionResult]), { owed: n1, delivered: "Partial" });

		const boundaries: NarrationDebtMessage[] = [
			{ role: "user", content: "Next prompt" },
			{ role: "custom", content: "marker" },
			toolResult("q1-ans", "quiz", "Answer A", false),
		];
		for (const boundary of boundaries) {
			assert.deepEqual(owedNarrationState([...baseRun1, boundary]), { owed: undefined, delivered: "" });
			const run2 = [
				...baseRun1,
				boundary,
				m2,
				toolResult("q2", "quiz", narrationBlockReason(m2 as never), true),
			];
			assert.deepEqual(owedNarrationState(run2), { owed: n2, delivered: "" });
		}
	});
});

describe("isNarrationBlock url-safe signatures", () => {
	it("recognizes narration markers in base64url thinking signatures", () => {
		const urlSafeSig = Buffer.concat([Buffer.from([0xfb, 0xff, 0xbf]), Buffer.from("narration!")]).toString("base64url");
		assert.ok(urlSafeSig.includes("-") && urlSafeSig.includes("_") && !urlSafeSig.includes("="));
		assert.equal(isNarrationBlock({ type: "thinking", thinkingSignature: urlSafeSig }), true);
	});
});

describe("projectView narration debt across runs", () => {
	it("shows run 2's owed narration for run 2's question after run 1 leaves an unpaid debt", () => {
		const n1 = "Run 1 hidden grading feedback.";
		const n2 = "Run 2 hidden grading feedback.";
		const run1Fail1 = { id: "m1", role: "assistant", stopReason: "toolUse", content: [thinking("narration", n1), quiz("q1")] };
		const run1Fail2 = { id: "m2", role: "assistant", stopReason: "toolUse", content: [thinking("narration", n1), quiz("q2")] };
		const run1Pose = { id: "m3", role: "assistant", stopReason: "toolUse", content: [quiz("q3")] };
		const run2Fail1 = { id: "m4", role: "assistant", stopReason: "toolUse", content: [thinking("narration", n2), quiz("q4")] };
		const run2Fail2 = { id: "m5", role: "assistant", stopReason: "toolUse", content: [thinking("narration", n2), quiz("q5")] };
		const run2Pose = { id: "m6", role: "assistant", stopReason: "toolUse", content: [quiz("q6")] };

		const view = projectView([
			run1Fail1,
			{ id: "r1", ...toolResult("q1", "quiz", narrationBlockReason(run1Fail1 as never), true) },
			run1Fail2,
			{ id: "r2", ...toolResult("q2", "quiz", narrationBlockReason(run1Fail2 as never), true) },
			run1Pose,
			{ id: "r3", ...toolResult("q3", "quiz", "Answer A", false), details: { answer: "A" } },
			run2Fail1,
			{ id: "r4", ...toolResult("q4", "quiz", narrationBlockReason(run2Fail1 as never), true) },
			run2Fail2,
			{ id: "r5", ...toolResult("q5", "quiz", narrationBlockReason(run2Fail2 as never), true) },
			run2Pose,
		] as never);

		const owedParts = view
			.flatMap((m) => m.parts)
			.filter((p) => p.type === OWED_NARRATION_PART_TYPE)
			.map((p) => (p.data as { text: string }).text);
		assert.deepEqual(owedParts, [n1, n2]);
	});

	it("still shows run 2's owed narration when its text matches run 1's", () => {
		const same = "Repeated hidden grading feedback.";
		const run1Fail = { id: "m1", role: "assistant", stopReason: "toolUse", content: [thinking("narration", same), quiz("q1")] };
		const run1Pose = { id: "m2", role: "assistant", stopReason: "toolUse", content: [quiz("q2")] };
		const run2Fail = { id: "m3", role: "assistant", stopReason: "toolUse", content: [thinking("narration", same), quiz("q3")] };
		const run2Pose = { id: "m4", role: "assistant", stopReason: "toolUse", content: [quiz("q4")] };

		const view = projectView([
			run1Fail,
			{ id: "r1", ...toolResult("q1", "quiz", narrationBlockReason(run1Fail as never), true) },
			run1Pose,
			{ id: "r2", ...toolResult("q2", "quiz", "Answer A", false), details: { answer: "A" } },
			run2Fail,
			{ id: "r3", ...toolResult("q3", "quiz", narrationBlockReason(run2Fail as never), true) },
			run2Pose,
		] as never);

		const owedParts = view
			.flatMap((m) => m.parts)
			.filter((p) => p.type === OWED_NARRATION_PART_TYPE)
			.map((p) => (p.data as { text: string }).text);
		assert.deepEqual(owedParts, [same, same]);
	});

	it("keeps owed narration across a non-rejection question error and shows it before the later question", () => {
		const n = "Hidden grading feedback that must survive a validation error.";
		const failBlock = { id: "m1", role: "assistant", stopReason: "toolUse", content: [thinking("narration", n), quiz("q1")] };
		const failValidation = { id: "m2", role: "assistant", stopReason: "toolUse", content: [quiz("q2")] };
		const passShort = { id: "m3", role: "assistant", stopReason: "toolUse", content: [sendToUser("Short.", "s3"), quiz("q3")] };

		const messages = [
			failBlock,
			{ id: "r1", ...toolResult("q1", "quiz", narrationBlockReason(failBlock as never), true) },
			failValidation,
			{ id: "r2", ...toolResult("q2", "quiz", "Tool validation failed: missing options.", true) },
			passShort,
			{ id: "r3", ...toolResult("s3", "send_to_user", "Message received for display.", false) },
		];

		assert.equal(owedNarration(messages as never), n);

		const view = projectView(messages as never);
		const parts = view.flatMap((m) => m.parts);
		const owedParts = parts
			.filter((p) => p.type === OWED_NARRATION_PART_TYPE)
			.map((p) => (p.data as { text: string }).text);
		assert.deepEqual(owedParts, [n]);

		const owedIndex = parts.findIndex((p) => p.type === OWED_NARRATION_PART_TYPE);
		const q3Index = parts.findIndex((p) => p.type === "tool-quiz" && p.toolCallId === "q3");
		assert.ok(owedIndex >= 0 && q3Index > owedIndex);
	});
});
