import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakState, breakTimings } from "../src/core/breaks.ts";
import { inputAppends } from "../src/core/input-events.ts";
import {
	newBreakNoteMessage,
	newBreakTakenMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";

const MINUTE_MS = 60_000;

function assistantSuggestBreak(id: string, toolCallId: string, timestamp: number): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "suggest_break", arguments: { requestedBy: "window" } }],
		api: "faux",
		provider: "synthetic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultSuggestBreak(id: string, toolCallId: string, timestamp: number): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId,
		toolName: "suggest_break",
		content: [{ type: "text", text: "Break offered." }],
		details: { ok: true, requestedBy: "window" },
		isError: false,
		timestamp,
	};
}

describe("breaks core mutant pins", () => {
	// plan 011 part 1: leadMs = 0 and reofferMs = 20 * 60_000 for every interval
	it("breakTimings sets leadMs to 0 and reofferMs to 20 min (X-15)", () => {
		const timings = breakTimings({ intervalMinutes: 50, lengthMinutes: 10, resetMinutes: 10 });
		assert.equal(timings.leadMs, 0);
		assert.equal(timings.reofferMs, 20 * MINUTE_MS);
	});

	it("breakState ignores escalation notes for a stale windowId (X-16)", () => {
		const messages: LhMessage[] = [
			{ id: "u1", role: "user", content: "Start", timestamp: 38 * MINUTE_MS },
			newBreakNoteMessage("window", "window", "win-2", 40 * MINUTE_MS),
			newBreakNoteMessage("escalation", "escalation", "win-1", 41 * MINUTE_MS),
		];
		const state = breakState(
			messages,
			undefined,
			breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 10 }),
			true,
			42 * MINUTE_MS,
		);
		assert.equal(state.window?.id, "win-2");
		assert.equal(state.window?.escalated, false);
	});

	it("inputAppends break-continue floors elapsed seconds (X-17)", () => {
		const messages: LhMessage[] = [
			{ id: "u1", role: "user", content: "Start", timestamp: 0 },
			assistantSuggestBreak("a1", "brk_1", 500),
			toolResultSuggestBreak("tr1", "brk_1", 500),
			newBreakTakenMessage("brk_1", 10, 1000),
		];
		const appends = inputAppends({ messages }, { type: "break-continue", toolCallId: "brk_1" }, 1700);
		assert.equal(appends.length, 1);
		assert.equal(appends[0]?.role, "custom");
		if (appends[0]?.role === "custom") {
			assert.ok(appends[0].content.includes("0:00 break"), appends[0].content);
		}
	});

	it("resolveSettings preserves an explicit 0 intervalMinutes (X-19)", () => {
		const resolved = resolveSettings({ version: 1, breaks: { intervalMinutes: 0 } });
		assert.equal(resolved.breaks.intervalMinutes, 0);
	});
});
