/** Narration guard cross-message delivery check tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeNarrationGuard, NARRATION_GUARD_MAX_BLOCKS } from "../src/agent/narration-guard.ts";

const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string, text = "") => ({ type: "thinking", thinking: text, thinkingSignature: sig(type) });
const quiz = (id = "t1") => ({ type: "toolCall", id, name: "quiz", arguments: {} });
const output = (message: string, id = "s1") => ({
	type: "toolCall", id, name: "send_to_user", arguments: { message },
});
const msg = (...content: unknown[]) => ({ role: "assistant", content }) as never;

const ask = (g: ReturnType<typeof makeNarrationGuard>, m: never, call = quiz()) =>
	g.beforeToolCall!({ assistantMessage: m, toolCall: call } as never);

const deliver = (g: ReturnType<typeof makeNarrationGuard>, m: never, call: ReturnType<typeof output>) =>
	g.afterToolCall!({ assistantMessage: m, toolCall: call, isError: false, result: { isError: false } } as never);

const CASE_16_13_NARRATION =
	"Your answer for part (a) has the right setup, because the derivative of x^2 is 2x, " +
	"but you dropped the negative sign from the chain rule when differentiating cos(3x).";
const CASE_16_13_BRIDGE = "Let us try one more check.";

const CASE_16_16_NARRATION =
	"You correctly identified the base case n = 0, and your inductive hypothesis is stated cleanly, " +
	"though the algebraic step from k to k + 1 skips why the extra factor cancels.";
const CASE_16_16_BRIDGE = "Quick follow-up:";

const CASE_16_24_NARRATION =
	"That intuition about energy conservation works here because friction is zero on the track, " +
	"so mechanical energy stays constant between the top and bottom of the ramp.";
const CASE_16_24_BRIDGE = "Here is the next question.";

const CASE_16_01_NARRATION =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1.";
const CASE_16_01_FULL_GRADING =
	"Nice work spotting that the series converges by the ratio test: the limit of |a_{n+1}/a_n| is 1/3, which is strictly less than 1, so the series converges absolutely.";

describe("makeNarrationGuard delivery check", () => {
	for (const [label, narration, bridge] of [
		["16:13", CASE_16_13_NARRATION, CASE_16_13_BRIDGE],
		["16:16", CASE_16_16_NARRATION, CASE_16_16_BRIDGE],
		["16:24", CASE_16_24_NARRATION, CASE_16_24_BRIDGE],
	] as const) {
		// plan 021 part 2: 16:13, 16:16, 16:24 replayed through the guard: after the short bridge, the reposted question is blocked again
		it(`${label}: blocks reposted question when send_to_user bridge is shorter than hidden narration`, async () => {
			const guard = makeNarrationGuard();
			const first = msg(thinking("narration", narration), quiz("q1"));
			const r1 = await ask(guard, first, quiz("q1"));
			assert.equal(r1?.block, true);

			const bridgeCall = output(bridge, "s1");
			const retry = msg(bridgeCall, quiz("q2"));
			await deliver(guard, retry, bridgeCall);
			const r2 = await ask(guard, retry, quiz("q2"));
			assert.equal(r2?.block, true);
			assert.ok(r2?.reason?.includes(narration));
		});
	}

	// plan 021 part 2: 16:01: the full grading clears the debt, and the reposted question passes
	it("16:01: clears debt when full grading is delivered and allows reposted question", async () => {
		const guard = makeNarrationGuard();
		const first = msg(thinking("narration", CASE_16_01_NARRATION), quiz("q1"));
		assert.equal((await ask(guard, first, quiz("q1")))?.block, true);

		const fullCall = output(CASE_16_01_FULL_GRADING, "s1");
		const retry = msg(fullCall, quiz("q2"));
		await deliver(guard, retry, fullCall);
		assert.equal(await ask(guard, retry, quiz("q2")), undefined);
	});

	// plan 021 owner decision 2: block when send_to_user text delivered is shorter than hidden narration text
	it("clears debt when delivered text has exact same trimmed length as hidden narration", async () => {
		const guard = makeNarrationGuard();
		const narration = "Exact length feedback.";
		const first = msg(thinking("narration", narration), quiz("q1"));
		assert.equal((await ask(guard, first, quiz("q1")))?.block, true);

		const equalCall = output("1234567890123456789012", "s1");
		assert.equal(equalCall.arguments.message.length, narration.length);
		const retry = msg(equalCall, quiz("q2"));
		await deliver(guard, retry, equalCall);
		assert.equal(await ask(guard, retry, quiz("q2")), undefined);
	});

	// plan 021 part 2: budget: after two blocks, the question passes
	it("allows the question after NARRATION_GUARD_MAX_BLOCKS even when debt is still owed", async () => {
		assert.equal(NARRATION_GUARD_MAX_BLOCKS, 2);
		const guard = makeNarrationGuard();

		const m1 = msg(thinking("narration", CASE_16_13_NARRATION), quiz("q1"));
		assert.equal((await ask(guard, m1, quiz("q1")))?.block, true);

		const bridgeCall = output(CASE_16_13_BRIDGE, "s1");
		const m2 = msg(bridgeCall, quiz("q2"));
		await deliver(guard, m2, bridgeCall);
		assert.equal((await ask(guard, m2, quiz("q2")))?.block, true);

		const m3 = msg(quiz("q3"));
		assert.equal(await ask(guard, m3, quiz("q3")), undefined);
	});

	// plan 021 part 2: a turn with no narration is never blocked
	it("never blocks a turn with no narration and no prior debt", async () => {
		const guard = makeNarrationGuard();
		assert.equal(await ask(guard, msg(thinking("thinking", "internal"), quiz("q1")), quiz("q1")), undefined);
		assert.equal(await ask(guard, msg(quiz("q2")), quiz("q2")), undefined);
	});

	// plan 021 part 2: a question in the same message after a long enough send_to_user passes
	it("allows a question in the same message after a send_to_user at least as long as the narration", async () => {
		const guard = makeNarrationGuard();
		const longCall = output(CASE_16_01_FULL_GRADING, "s1");
		const sameTurn = msg(thinking("narration", CASE_16_01_NARRATION), longCall, quiz("q1"));
		await deliver(guard, sameTurn, longCall);
		assert.equal(await ask(guard, sameTurn, quiz("q1")), undefined);
	});

	// plan 021 owner decision 2: block when send_to_user text delivered is shorter than hidden narration text
	it("blocks a question in the same message when send_to_user is shorter than the narration", async () => {
		const guard = makeNarrationGuard();
		const shortCall = output(CASE_16_13_BRIDGE, "s1");
		const sameTurn = msg(thinking("narration", CASE_16_13_NARRATION), shortCall, quiz("q1"));
		await deliver(guard, sameTurn, shortCall);
		const res = await ask(guard, sameTurn, quiz("q1"));
		assert.equal(res?.block, true);
		assert.ok(res?.reason?.includes(CASE_16_13_NARRATION));
	});
});
