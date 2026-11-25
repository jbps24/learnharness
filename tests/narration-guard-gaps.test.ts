/** Narration guard: accumulated deliveries, blank deliveries, and new narration after a cleared debt. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeNarrationGuard } from "../src/agent/narration-guard.ts";

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

describe("makeNarrationGuard gaps", () => {
	it("adds up several deliveries to clear the owed narration", async () => {
		const guard = makeNarrationGuard();
		const narration = "x".repeat(30);
		assert.equal((await ask(guard, msg(thinking("narration", narration), quiz("q1")), quiz("q1")))?.block, true);

		const a = output("a".repeat(20), "s1");
		const b = output("b".repeat(20), "s2");
		const retry = msg(a, b, quiz("q2"));
		await deliver(guard, retry, a);
		await deliver(guard, retry, b);
		assert.equal(await ask(guard, retry, quiz("q2")), undefined);
	});

	it("a whitespace-only delivery does not clear a block with empty narration text", async () => {
		const guard = makeNarrationGuard();
		const blank = output("   ", "s1");
		const m = msg(thinking("narration", ""), blank, quiz("q1"));
		await deliver(guard, m, blank);
		assert.equal((await ask(guard, m, quiz("q1")))?.block, true);
	});

	it("checks the current message's own narration after the old debt is cleared", async () => {
		const guard = makeNarrationGuard();
		assert.equal((await ask(guard, msg(thinking("narration", "n".repeat(50)), quiz("q1")), quiz("q1")))?.block, true);

		const call = output("d".repeat(60), "s1");
		const fresh = "f".repeat(200);
		const retry = msg(thinking("narration", fresh), call, quiz("q2"));
		await deliver(guard, retry, call);
		const r = await ask(guard, retry, quiz("q2"));
		assert.equal(r?.block, true);
		assert.ok(r?.reason?.includes(fresh));
	});
});
