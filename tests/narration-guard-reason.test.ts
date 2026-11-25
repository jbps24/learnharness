/** Narration guard rejection reason and delivery rule tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	makeNarrationGuard,
	narrationBlockReason,
	SEND_TO_USER_DELIVERY_RULE,
} from "../src/agent/narration-guard.ts";

const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string, text = "") => ({ type: "thinking", thinking: text, thinkingSignature: sig(type) });
const quiz = { type: "toolCall", id: "t1", name: "quiz", arguments: {} };
const msg = (...content: unknown[]) => ({ role: "assistant", content }) as never;

describe("narrationBlockReason", () => {
	// plan 021 part 1: reason quotes the hidden narration text back to the model
	it("quotes hidden narration text from a narration thinking block", () => {
		const narration = "Good start on the first step, let us check the next one.";
		const reason = narrationBlockReason(msg(thinking("thinking", "internal"), thinking("narration", narration), quiz));
		assert.ok(reason.length > 0);
		// owner decision 1: say plainly that the learner saw none of the text
		assert.match(reason, /learner/i);
		assert.equal(reason, `The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking. Your hidden text: «${narration}». Send that content in full through \`send_to_user\`: the grading of the learner's answer, corrections, and a reply to anything the learner asked. Then pose the question again.`);
		assert.ok(reason.includes(narration));
		assert.equal(reason.includes("internal"), false);
	});

	// plan 021 part 1: a narration block with empty text gives the reason without the quote sentence
	it("returns a non-empty reason without quoting when narration text is empty", () => {
		const emptyReason = narrationBlockReason(msg(thinking("narration", ""), quiz));
		const quotedReason = narrationBlockReason(msg(thinking("narration", "Hidden feedback."), quiz));
		assert.ok(emptyReason.length > 0);
		assert.notEqual(emptyReason, quotedReason);
	});

	it("returns the confirmed text without the quote sentence when narration text is empty", () => {
		const emptyReason = narrationBlockReason(msg(thinking("narration", ""), quiz));
		assert.equal(
			emptyReason,
			"The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking. Send that content in full through `send_to_user`: the grading of the learner's answer, corrections, and a reply to anything the learner asked. Then pose the question again.",
		);
	});
});

describe("SEND_TO_USER_DELIVERY_RULE", () => {
	// plan 021 part 1 & owner decision 4: Claude-only delivery rule includes the grading-first rule
	it("includes the grading-first rule", () => {
		const tail = SEND_TO_USER_DELIVERY_RULE.slice(-400);
		assert.ok(tail.endsWith("When the learner has answered a question, your first call is `send_to_user` with your grading of that answer: what was right, what was wrong, and why. Only then pose the next question."));
		assert.match(SEND_TO_USER_DELIVERY_RULE.trimEnd(), /[.!]$/);
	});
});

describe("makeNarrationGuard reason", () => {
	// plan 021 part 1: the guard blocks with the new reason from narrationBlockReason
	it("blocks a question with the reason produced by narrationBlockReason", async () => {
		const narration = "Your explanation is mostly right, except for the sign.";
		const message = msg(thinking("narration", narration), quiz);
		const guard = makeNarrationGuard();
		const result = await guard.beforeToolCall!({ assistantMessage: message, toolCall: quiz } as never);
		assert.equal(result?.block, true);
		assert.equal(result?.reason, narrationBlockReason(message));
		assert.ok(result?.reason?.includes(narration));
	});
});
