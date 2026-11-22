import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DRAW_STATUS_MIN,
	DRAWN_BUDGET,
	SMALL_REST,
	drawStatusNeeded,
	drawnBoundaries,
	drawnPartFilter,
	drawnStartBefore,
	drawnStartForTarget,
	initialDrawnStart,
	messageSize,
	projectView,
	showEarlierStart,
	startId,
	startIndex,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/index.ts";

const userMsg = (id: string, text = "hi"): LhMessage =>
	({ id, role: "user", content: text, timestamp: 1 }) as never;

const sizedUserMsg = (id: string, targetBytes: number): LhMessage => {
	const base = JSON.stringify(userMsg(id, "")).length;
	const pad = Math.max(0, targetBytes - base);
	const msg = userMsg(id, "x".repeat(pad));
	assert.equal(JSON.stringify(msg).length, targetBytes);
	return msg;
};

const assistantTextMsg = (id: string, text = "ok"): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 2 }) as never;

const sizedAssistantMsg = (id: string, targetBytes: number): LhMessage => {
	const base = JSON.stringify(assistantTextMsg(id, "")).length;
	const pad = Math.max(0, targetBytes - base);
	const msg = assistantTextMsg(id, "y".repeat(pad));
	assert.equal(JSON.stringify(msg).length, targetBytes);
	return msg;
};

const assistantQuizMsg = (id: string, callIds: string[]): LhMessage =>
	({
		id,
		role: "assistant",
		content: callIds.map((callId) => ({
			type: "toolCall",
			id: callId,
			name: "quiz",
			arguments: { question: "Q?", options: ["A", "B"], correctIndex: 0 },
		})),
		timestamp: 2,
	}) as never;

const quizAnswerMsg = (id: string, callId: string): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text: "A" }],
		isError: false,
		details: {
			kind: "quiz",
			questionText: "Q?",
			dontKnow: false,
			answers: ["A"],
			answeredAt: "2026-11-22T00:00:00.000Z",
		},
		timestamp: 3,
	}) as never;

const practiceThinkingMsg = (id: string, problemCallId = "p1"): LhMessage =>
	({
		id,
		role: "custom",
		customType: "practice-thinking",
		content: "thinking",
		display: true,
		details: { problemCallId, commit: false, text: "thinking" },
		timestamp: 4,
	}) as never;

const subagentSteerMsg = (id: string): LhMessage =>
	({
		id,
		role: "custom",
		customType: "subagent-steer",
		content: "artifact",
		display: true,
		details: { kind: "pdf", result: { title: "doc" } },
		timestamp: 5,
	}) as never;

describe("drawn-history constants and messageSize", () => {
	// plan 003 part 1: constants DRAWN_BUDGET, SMALL_REST, DRAW_STATUS_MIN
	it("exports DRAWN_BUDGET, SMALL_REST, and DRAW_STATUS_MIN with the plan values", () => {
		assert.equal(DRAWN_BUDGET, 276_480);
		assert.equal(SMALL_REST, 69_120);
		assert.equal(DRAW_STATUS_MIN, 82_944);
	});

	// plan 003 part 1: messageSize(m) = JSON.stringify(m).length
	it("messageSize returns JSON.stringify(m).length", () => {
		const m = userMsg("u1", "hello world");
		assert.equal(messageSize(m), JSON.stringify(m).length);
	});
});

describe("drawnBoundaries", () => {
	// plan 003 part 1: index 0 is always a boundary and b = n is never a boundary
	it("always includes 0 and never includes messages.length", () => {
		const msgs = [userMsg("u1"), assistantTextMsg("a1")];
		assert.deepEqual(drawnBoundaries(msgs), [0, 1]);

		// a trailing learner input would put the boundary at n, which is never one
		const endsWithInput = [userMsg("u1"), assistantTextMsg("a1"), userMsg("u2")];
		assert.deepEqual(drawnBoundaries(endsWithInput), [0, 1]);
	});

	// plan 003 part 1: boundary lands right after typed user, quiz answer toolResult, practice-thinking, and learner steer
	it("places boundaries right after typed user, quiz answer toolResult, practice-thinking, and learner steer", () => {
		const msgs = [
			userMsg("u0", "typed"),
			assistantQuizMsg("a1", ["q1"]),
			quizAnswerMsg("r2", "q1"),
			assistantTextMsg("a3", "reaction"),
			practiceThinkingMsg("pt4"),
			assistantTextMsg("a5", "reply"),
			userMsg("u6", "steer"),
			assistantTextMsg("a7", "after steer"),
		];
		assert.deepEqual(drawnBoundaries(msgs), [0, 1, 3, 5, 7]);
	});

	// plan 003 part 1: never a boundary after an automatic input (subagent-steer) or an assistant message
	it("never places a boundary after subagent-steer or assistant message", () => {
		const msgs = [
			userMsg("u0"),
			assistantTextMsg("a1"),
			subagentSteerMsg("ss2"),
			assistantTextMsg("a3"),
		];
		assert.deepEqual(drawnBoundaries(msgs), [0, 1]);
	});

	// plan 003 part 1: unclean boundary is skipped when two question calls exist and the second is answered after more messages
	it("skips an unclean boundary when an earlier tool call has its toolResult at index >= b", () => {
		const msgs = [
			userMsg("u0"),
			assistantQuizMsg("a1", ["q1", "q2"]),
			quizAnswerMsg("r2", "q1"),
			assistantTextMsg("a3", "still waiting for q2"),
			quizAnswerMsg("r4", "q2"),
			assistantTextMsg("a5", "both answered"),
		];
		assert.deepEqual(drawnBoundaries(msgs), [0, 1, 5]);
	});
});

describe("initialDrawnStart and drawnStartBefore", () => {
	// plan 003 part 1: drawnStartBefore returns 0 for end = 0 and initialDrawnStart returns 0 for empty session
	it("returns 0 for empty session and end = 0", () => {
		assert.equal(drawnStartBefore([], 0), 0);
		assert.equal(initialDrawnStart([]), 0);
	});

	// plan 003 part 1: session under DRAWN_BUDGET draws whole (start = 0)
	it("returns 0 when the whole session is under DRAWN_BUDGET", () => {
		const msgs = [
			sizedUserMsg("u0", 80_000),
			sizedAssistantMsg("a1", 80_000),
			sizedUserMsg("u2", 80_000),
			sizedAssistantMsg("a3", 30_000),
		];
		assert.equal(initialDrawnStart(msgs), 0);
	});

	// plan 003 part 1: session whose rest would be < SMALL_REST (69_120) returns 0
	it("returns 0 when the earlier history would be under SMALL_REST", () => {
		const msgs = [
			sizedUserMsg("u0", 69_119),
			sizedAssistantMsg("a1", 100),
			sizedUserMsg("u2", 276_480),
			sizedAssistantMsg("a3", 100),
		];
		assert.equal(initialDrawnStart(msgs), 0);
	});

	// plan 003 part 1: earlier history of exactly SMALL_REST (69_120) is not under SMALL_REST and keeps the cut
	it("keeps the cut when the earlier history is exactly SMALL_REST", () => {
		const msgs = [
			sizedUserMsg("u0", 69_120),
			sizedAssistantMsg("a1", 100),
			sizedUserMsg("u2", 276_480),
			sizedAssistantMsg("a3", 100),
		];
		assert.equal(initialDrawnStart(msgs), 1);
	});

	// plan 003 part 1: cut picks largest boundary with size(messages[b..end)) >= DRAWN_BUDGET
	it("picks the largest boundary whose range reaches DRAWN_BUDGET and falls back when 1 char short", () => {
		const exact = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 100),
			sizedUserMsg("u2", 100),
			sizedAssistantMsg("a3", 276_480),
		];
		assert.equal(initialDrawnStart(exact), 3);

		const oneShort = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 100),
			sizedUserMsg("u2", 100),
			sizedAssistantMsg("a3", 276_479),
		];
		assert.equal(initialDrawnStart(oneShort), 1);
	});

	// plan 003 part 1: cut lands right after typed message, quiz answer toolResult, practice-thinking, and learner steer
	it("lands right after typed user, quiz answer toolResult, practice-thinking, and learner steer", () => {
		const afterTyped = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 276_480),
		];
		assert.equal(initialDrawnStart(afterTyped), 1);

		const afterQuiz = [
			sizedUserMsg("u0", 70_000),
			assistantQuizMsg("a1", ["q1"]),
			quizAnswerMsg("r2", "q1"),
			sizedAssistantMsg("a3", 276_480),
		];
		assert.equal(initialDrawnStart(afterQuiz), 3);

		const afterThinking = [
			sizedUserMsg("u0", 70_000),
			practiceThinkingMsg("pt1"),
			sizedAssistantMsg("a2", 276_480),
		];
		assert.equal(initialDrawnStart(afterThinking), 2);

		const afterSteer = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 100),
			userMsg("u2", "steer"),
			sizedAssistantMsg("a3", 276_480),
		];
		assert.equal(initialDrawnStart(afterSteer), 3);
	});

	// plan 003 part 1: cut never lands right after an automatic input (subagent-steer) or an assistant message
	it("never lands right after subagent-steer or assistant message", () => {
		const msgs = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 100),
			subagentSteerMsg("ss2"),
			sizedAssistantMsg("a3", 280_000),
		];
		assert.equal(initialDrawnStart(msgs), 1);
	});
});

describe("showEarlierStart, drawnStartForTarget, and drawStatusNeeded", () => {
	// plan 003 part 1: showEarlierStart steps one budget-step earlier and reaches 0 at the start
	it("showEarlierStart steps once more and reaches 0 at the start", () => {
		const msgs = [
			sizedUserMsg("u0", 80_000),
			sizedAssistantMsg("a1", 200_000),
			sizedUserMsg("u2", 100),
			sizedAssistantMsg("a3", 200_000),
			sizedUserMsg("u4", 100),
			sizedAssistantMsg("a5", 280_000),
		];
		const start1 = initialDrawnStart(msgs);
		assert.equal(start1, 5);
		const start2 = showEarlierStart(msgs, start1);
		assert.equal(start2, 1);
		const start3 = showEarlierStart(msgs, start2);
		assert.equal(start3, 0);
	});

	// plan 003 part 1: drawnStartForTarget = min(current, largest boundary <= targetIndex), or 0 when none
	it("drawnStartForTarget handles targets in drawn history, earlier history, and before first boundary", () => {
		const msgs = [
			userMsg("u0"),
			assistantTextMsg("a1"),
			userMsg("u2"),
			assistantTextMsg("a3"),
			userMsg("u4"),
			assistantTextMsg("a5"),
		];
		// boundaries: [0, 1, 3, 5]
		assert.equal(drawnStartForTarget(msgs, 5, 5), 5);
		assert.equal(drawnStartForTarget(msgs, 4, 5), 3);
		assert.equal(drawnStartForTarget(msgs, 3, 5), 3);
		assert.equal(drawnStartForTarget(msgs, 0, 5), 0);
		// min(current, ...): a target deeper in the drawn history never raises the start
		assert.equal(drawnStartForTarget(msgs, 5, 3), 3);
	});

	// plan 003 part 1: drawStatusNeeded = size(messages[from..to)) >= DRAW_STATUS_MIN (82_944)
	it("drawStatusNeeded checks size(messages[from..to)) >= DRAW_STATUS_MIN", () => {
		const msgs = [
			sizedUserMsg("u0", 82_943),
			sizedUserMsg("u1", 82_944),
		];
		assert.equal(drawStatusNeeded(msgs, 0, 1), false);
		assert.equal(drawStatusNeeded(msgs, 1, 2), true);
		assert.equal(drawStatusNeeded(msgs, 1, 1), false);
	});
});

describe("startId and startIndex", () => {
	// plan 003 part 1: startId(messages, index) = index === 0 ? null : messages[index].id
	it("startId returns null for 0 and messages[index].id for index > 0", () => {
		const msgs = [userMsg("u0"), assistantTextMsg("a1"), userMsg("u2")];
		assert.equal(startId(msgs, 0), null);
		assert.equal(startId(msgs, 2), "u2");
	});

	// plan 003 part 1: startIndex(messages, id) returns 0 for null, index for found id, or initialDrawnStart when missing
	it("startIndex returns 0 for null, matching index for known id, and initialDrawnStart for missing id", () => {
		const msgs = [
			sizedUserMsg("u0", 70_000),
			sizedAssistantMsg("a1", 280_000),
		];
		assert.equal(startIndex(msgs, null), 0);
		assert.equal(startIndex(msgs, "a1"), 1);
		assert.equal(startIndex(msgs, "missing-id"), initialDrawnStart(msgs));
	});
});

describe("projectView sourceMessageId and drawnPartFilter", () => {
	// plan 003 part 1: projectView sets sourceMessageId on every part kind (text, reasoning, tool, user, marker, unit/compaction-cut)
	it("projectView sets sourceMessageId on user, assistant, tool, marker, and cut-divider parts", () => {
		const msgs: LhMessage[] = [
			{ id: "m_gc", role: "custom", customType: "graph-context", content: "", display: true, details: { topic: "T" }, timestamp: 1 } as never,
			{ id: "m_u1", role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 2 } as never,
			{
				id: "m_a1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "hello" },
					{ type: "toolCall", id: "stu1", name: "send_to_user", arguments: { message: "prose" } },
					{ type: "toolCall", id: "pi1", name: "plan_init", arguments: {} },
					{ type: "toolCall", id: "sb1", name: "suggest_break", arguments: {} },
				],
				timestamp: 3,
			} as never,
			{
				id: "m_r_pi1",
				role: "toolResult",
				toolCallId: "pi1",
				toolName: "plan_init",
				content: [],
				isError: false,
				details: { ok: true, tree: { units: [{ id: "u1", title: "Unit 1" }] } },
				timestamp: 4,
			} as never,
			{ id: "m_pb1", role: "custom", customType: "plan-block", content: "", display: true, details: { planCallId: "pi1", block: { id: "b1" } }, timestamp: 5 } as never,
			{ id: "m_r_sb1", role: "toolResult", toolCallId: "sb1", toolName: "suggest_break", content: [], isError: false, details: { ok: true }, timestamp: 6 } as never,
			{ id: "m_ss1", role: "custom", customType: "subagent-steer", content: "sa", display: true, details: { kind: "pdf", result: { title: "doc" } }, timestamp: 7 } as never,
			{ id: "m_sa1", role: "custom", customType: "subagent-abort", content: "ab", display: true, details: { aborted: true }, timestamp: 8 } as never,
			{ id: "m_ph1", role: "custom", customType: "probe-handoff", content: "", display: true, details: { summary: "s" }, timestamp: 9 } as never,
			{ id: "m_ps1", role: "custom", customType: "plugin-problem-submission", content: "", display: true, details: { text: "p" }, timestamp: 10 } as never,
			{ id: "m_pt1", role: "custom", customType: "practice-thinking", content: "t", display: true, details: { problemCallId: "p1", commit: false, text: "t" }, timestamp: 11 } as never,
			{ id: "m_pn1", role: "custom", customType: "practice-next", content: "next", display: true, details: null, timestamp: 12 } as never,
			{ id: "m_lr1", role: "custom", customType: "lesson-record", content: "", display: false, details: { firstKeptMessageId: "m_u2", currentUnitId: "u1", finishedUnitIds: [] }, timestamp: 13 } as LhMarkerMessage as never,
			{ id: "m_cm1", role: "custom", customType: "compaction", content: "sum", display: true, details: { firstKeptMessageId: "m_u2", tokensBefore: 100, at: "2026-11-22T00:00:00.000Z" }, timestamp: 14 } as never,
			userMsg("m_u2", "kept"),
			{ id: "m_a_empty", role: "assistant", content: [], timestamp: 15 } as never,
		];

		const view = projectView(msgs, {
			executions: new Map(),
			inFlight: true,
			streamingIds: new Set(["m_a_empty"]),
		});

		const allParts = view.flatMap((m) => m.parts);
		const byType = (t: string) => allParts.filter((p) => p.type === t);

		assert.equal(byType("data-graph-context")[0]?.sourceMessageId, "m_gc");
		assert.deepEqual(view.find((m) => m.id === "m_u1")?.parts.map((p) => p.sourceMessageId), ["m_u1", "m_u1"]);
		assert.equal(byType("reasoning")[0]?.sourceMessageId, "m_a1");
		assert.equal(byType("tool-plan_init")[0]?.sourceMessageId, "m_a1");
		assert.equal(byType("data-plan-block")[0]?.sourceMessageId, "m_pb1");
		assert.equal(byType("data-break")[0]?.sourceMessageId, "m_r_sb1");
		assert.equal(byType("data-subagent-artifact")[0]?.sourceMessageId, "m_ss1");
		assert.equal(byType("data-subagent-aborted")[0]?.sourceMessageId, "m_sa1");
		assert.equal(byType("data-probe-handoff")[0]?.sourceMessageId, "m_ph1");
		assert.equal(byType("data-plugin-problem-submission")[0]?.sourceMessageId, "m_ps1");
		assert.equal(byType("data-practice-thinking")[0]?.sourceMessageId, "m_pt1");
		assert.equal(byType("data-practice-next")[0]?.sourceMessageId, "m_pn1");
		assert.equal(byType("data-compaction")[0]?.sourceMessageId, "m_cm1");
		assert.equal(byType("data-unit-cut")[0]?.sourceMessageId, "m_u2");
		assert.equal(byType("data-compaction-cut")[0]?.sourceMessageId, "m_u2");
		assert.equal(byType("reasoning")[1]?.sourceMessageId, "m_a_empty");

		// Assistant text parts from m_a1 (both plain text and send_to_user)
		const assistantGroup = view.find((m) => m.id === "m_a1")!;
		const a1Texts = assistantGroup.parts.filter((p) => p.type === "text");
		assert.deepEqual(a1Texts.map((p) => p.sourceMessageId), ["m_a1", "m_a1"]);
	});

	// plan 003 part 1: drawnPartFilter keeps parts of a row the cut falls inside only from the cut on, and always keeps unknown/live parts
	it("drawnPartFilter keeps parts of a split assistant row only from the cut on, and keeps unknown/live parts", () => {
		const msgs = [
			userMsg("u0", "q"),
			assistantTextMsg("a1", "first step"),
			assistantTextMsg("a2", "second step"),
		];
		const view = projectView(msgs);
		const assistantRow = view.find((m) => m.id === "a1")!;

		// start = 0 keeps everything
		assert.equal(assistantRow.parts.filter(drawnPartFilter(msgs, 0)).length, assistantRow.parts.length);

		// start = 2 (a2) keeps only a2's parts inside the grouped row
		const filtered = assistantRow.parts.filter(drawnPartFilter(msgs, 2));
		assert.equal(filtered.length > 0, true);
		assert.equal(filtered.every((p) => p.sourceMessageId === "a2"), true);

		// unknown and live (undefined sourceMessageId) parts are always drawn
		const filter = drawnPartFilter(msgs, 2);
		assert.equal(filter({ type: "text", text: "live" }), true);
		assert.equal(filter({ type: "text", text: "unknown", sourceMessageId: "nope" }), true);
		assert.equal(filter({ type: "text", text: "old", sourceMessageId: "a1" }), false);
	});
});
