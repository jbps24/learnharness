import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { createTeacherTools } from "../src/agent/tools.ts";
import { breakCountdown, formatAway, learningMinutes } from "../src/core/breaks.ts";
import type { ChatRecord } from "../src/core/contracts.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { newAnswerResult, newBreakNoteMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import { prepareUnitCutDuringBreak } from "../src/server/break-cut-prep.ts";
import { setRunningUnit, type CompactionDeps } from "../src/server/compaction.ts";
import { preparedJudgments } from "../src/server/unit-cut.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const T0 = 1_700_000_000_000;

const SYNTHETIC_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeChatStore(initial: ChatRecord): ChatStore {
	const chats = new Map<string, ChatRecord>([[initial.id, initial]]);
	return {
		createChat: () => {
			throw new Error("not implemented");
		},
		getChat: (id: string) => chats.get(id) ?? null,
		listChats: () => [],
		retireReply: () => { throw new Error("retireReply is not used here"); },
		saveMessages: (id: string, messages: readonly LhMessage[]) => {
			const c = chats.get(id);
			if (c) c.messages = [...messages];
		},
		saveImageSnapshot: () => {},
		saveTree: (id: string, tree: PlanTree) => {
			const c = chats.get(id);
			if (c) c.tree = tree;
		},
		appendTurnUsage: () => {},
		appendExtractionUsage: () => {},
		saveSettings: () => {},
		renameChat: () => {
			throw new Error("not implemented");
		},
		deleteChat: () => false,
		updateSideChats: () => null,
		getCourseMaterial: () => null,
		setCourseMaterial: () => {},
	};
}

function userMsg(id: string, timestamp: number): LhMessage {
	return { id, role: "user", content: "ok", timestamp };
}

function teachQuizMsg(id: string, callId: string, nodeId: string, timestamp: number): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "quiz",
				arguments: {
					type: "check",
					nodeId,
					question: `Q for ${nodeId}?`,
					options: [{ label: "A" }, { label: "B" }],
					correctAnswer: "A",
				},
			},
		],
		api: "faux",
		provider: "synthetic",
		model: "synthetic",
		usage: SYNTHETIC_USAGE,
		stopReason: "toolUse",
		timestamp,
	} as unknown as LhMessage;
}

function answeredQuiz(idPrefix: string, callId: string, nodeId: string, timestamp: number): LhMessage[] {
	return [
		teachQuizMsg(`${idPrefix}_q`, callId, nodeId, timestamp),
		{
			...newAnswerResult(callId, "quiz", {
				kind: "quiz",
				questionText: `Q for ${nodeId}?`,
				dontKnow: false,
				answers: ["A"],
				answeredAt: "2026-11-21T00:00:00.000Z",
			}),
			timestamp: timestamp + 1,
		},
	];
}

describe("formatAway", () => {
	// plan 002 part 9: formatAway(0) -> "0 min"
	it("formats 0 ms as 0 min", () => {
		assert.equal(formatAway(0), "0 min");
	});

	// plan 002 part 9: formatAway(18 min) -> "18 min"; whole minutes m = floor(ms / 60 000)
	it("formats minutes under 1 hour using floor(ms / 60 000)", () => {
		assert.equal(formatAway(18 * MINUTE_MS), "18 min");
		assert.equal(formatAway(59 * MINUTE_MS + 59_000), "59 min");
	});

	// plan 002 part 9: formatAway(120 min) -> "2 h", leaving out a zero minutes part
	it("formats exact hours under 24 h without a zero minutes part", () => {
		assert.equal(formatAway(120 * MINUTE_MS), "2 h");
	});

	// plan 002 part 9: formatAway(134 min) -> "2 h 14 min"; formatAway(23 h 59 min) -> "23 h 59 min"
	it("formats hours and minutes from 1 h to under 24 h", () => {
		assert.equal(formatAway(134 * MINUTE_MS), "2 h 14 min");
		assert.equal(formatAway((23 * 60 + 59) * MINUTE_MS), "23 h 59 min");
	});

	// plan 002 part 9: formatAway(24 h) -> "1 d"; formatAway(72 h) -> "3 d", leaving out a zero hours part
	it("formats exact days from 24 h without a zero hours part", () => {
		assert.equal(formatAway(24 * HOUR_MS), "1 d");
		assert.equal(formatAway(72 * HOUR_MS), "3 d");
	});

	// plan 002 part 9: formatAway(74 h 30 min) -> "3 d 2 h"
	it("formats days and whole hours from 24 h, omitting minutes", () => {
		assert.equal(formatAway(74 * HOUR_MS + 30 * MINUTE_MS), "3 d 2 h");
	});
});

describe("breakCountdown", () => {
	// plan 002 part 9: breakCountdown(0, 10, 19_000) -> "9:41", not over
	it("formats remaining time m:ss rounded up while not over", () => {
		const res = breakCountdown(0, 10, 19_000);
		assert.equal(res.label, "9:41");
		assert.equal(res.over, false);
		assert.equal(res.progress, 19_000 / 600_000);
	});

	// plan 002 part 9: the remaining time is rounded up to the next second
	it("rounds a fractional remaining second up", () => {
		assert.equal(breakCountdown(0, 10, 19_500).label, "9:41");
		assert.equal(breakCountdown(0, 10, 599_001).label, "0:01");
	});

	// plan 002 part 9: from over >= 1000, label is "+m:ss" of floor(over / 1000)
	it("floors a fractional over time", () => {
		assert.equal(breakCountdown(0, 10, 601_999).label, "+0:01");
	});

	// plan 002 part 9: (0, 10, 600_000) -> "0:00", not over, progress 1; (0, 10, 600_999) -> "0:00", not over; "+0:00" never appears
	it("stays at 0:00 and not over while over < 1000 ms", () => {
		assert.deepEqual(breakCountdown(0, 10, 600_000), { label: "0:00", over: false, progress: 1 });
		assert.deepEqual(breakCountdown(0, 10, 600_999), { label: "0:00", over: false, progress: 1 });
	});

	// plan 002 part 9: (0, 10, 601_000) -> "+0:01", over; (0, 10, 683_000) -> "+1:23", over
	it("switches to +m:ss and over: true from over >= 1000 ms", () => {
		assert.deepEqual(breakCountdown(0, 10, 601_000), { label: "+0:01", over: true, progress: 1 });
		assert.deepEqual(breakCountdown(0, 10, 683_000), { label: "+1:23", over: true, progress: 1 });
	});
});

describe("learningMinutes", () => {
	// plan 002 part 9: learningMinutes with learningMs 0 -> 0
	it("returns 0 when learningMs is 0", () => {
		assert.equal(learningMinutes({ learningMs: 0, startedAt: null, awayMs: null }), 0);
	});

	// plan 002 part 9: learningMinutes 38 min 59 s -> 38; 72 min -> 72 (never hours)
	it("floors learningMs to whole minutes without converting to hours", () => {
		assert.equal(learningMinutes({ learningMs: 38 * MINUTE_MS + 59_000, startedAt: T0, awayMs: null }), 38);
		assert.equal(learningMinutes({ learningMs: 72 * MINUTE_MS, startedAt: T0, awayMs: null }), 72);
	});

	// plan 002 part 9: learningMinutes returns 0 when clock.awayMs !== null (a reset)
	it("returns 0 whenever awayMs is set", () => {
		assert.equal(learningMinutes({ learningMs: 40 * MINUTE_MS, startedAt: T0, awayMs: 5 * MINUTE_MS }), 0);
		assert.equal(learningMinutes({ learningMs: 0, startedAt: T0, awayMs: 0 }), 0);
	});
});

describe("createTeacherTools breaks & now", () => {
	// plan 002 part 9: createTeacherTools given breaks returning { enabled: true, intervalMinutes: 30, lengthMinutes: 7 } and a fixed now makes suggest_break's window checks use 30/7 and that clock
	it("passes breaks settings (30/7) and fixed now through to suggest_break window checks", async () => {
		const activityEnd = T0 + 28 * MINUTE_MS + 1;
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			newBreakNoteMessage("window", "[Session note] break due", undefined, T0 + 27 * MINUTE_MS),
			...answeredQuiz("q1", "call_q1", "n1", T0 + 28 * MINUTE_MS),
		];
		const chatStore = makeChatStore({
			id: "chat_1",
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			messages,
		});
		const jobStore = {} as unknown as JobStore;
		const breaks = () => ({ enabled: true, intervalMinutes: 30, lengthMinutes: 7, resetMinutes: 7 });

		// 6 min after activityEnd (< 7 min lengthMinutes): window stays open.
		const beforeReset = createTeacherTools({
			chatId: "chat_1",
			chatStore,
			jobStore,
			spawn: () => {},
			breaks,
			now: () => activityEnd + 6 * MINUTE_MS,
		});
		const okRes = await beforeReset.suggest_break!.execute("call_sb_1", { requestedBy: "window" });
		assert.deepEqual(okRes.details, { ok: true, requestedBy: "window" });

		// 7 min after activityEnd (>= 7 min lengthMinutes): clock resets, window closes.
		const afterReset = createTeacherTools({
			chatId: "chat_1",
			chatStore,
			jobStore,
			spawn: () => {},
			breaks,
			now: () => activityEnd + 7 * MINUTE_MS,
		});
		const refusedRes = await afterReset.suggest_break!.execute("call_sb_2", { requestedBy: "window" });
		assert.deepEqual(refusedRes.details, { ok: false });
	});

	// plan 011 part 2: createTeacherTools suggest_break carries oneMoreQuestion for window and refuses learner with R5
	it("passes oneMoreQuestion through createTeacherTools suggest_break and enforces R5", async () => {
		const activityEnd = T0 + 28 * MINUTE_MS + 1;
		const messages: LhMessage[] = [
			userMsg("u1", T0),
			newBreakNoteMessage("window", "[Session note] break due", undefined, T0 + 27 * MINUTE_MS),
			...answeredQuiz("q1", "call_q1", "n1", T0 + 28 * MINUTE_MS),
		];
		const chatStore = makeChatStore({
			id: "chat_1",
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			messages,
		});
		const jobStore = {} as unknown as JobStore;
		const tools = createTeacherTools({
			chatId: "chat_1",
			chatStore,
			jobStore,
			spawn: () => {},
			breaks: () => ({ enabled: true, intervalMinutes: 30, lengthMinutes: 7, resetMinutes: 7 }),
			now: () => activityEnd + 6 * MINUTE_MS,
		});

		const okRes = await tools.suggest_break!.execute("call_sb_om", { requestedBy: "window", oneMoreQuestion: true });
		assert.deepEqual(okRes.details, { ok: true, requestedBy: "window", oneMoreQuestion: true });

		const r5Res = await tools.suggest_break!.execute("call_sb_r5", { requestedBy: "learner", oneMoreQuestion: true });
		assert.deepEqual(r5Res.details, { ok: false });
		assert.equal(
			r5Res.content[0]?.type === "text" ? r5Res.content[0].text : "",
			'oneMoreQuestion only goes with requestedBy "window".',
		);
	});
});

describe("prepareUnitCutDuringBreak runningUnit guard", () => {
	const chatId = "chat-running-unit";

	beforeEach(() => {
		preparedJudgments.clear();
		setRunningUnit(chatId, undefined);
	});

	afterEach(() => {
		preparedJudgments.clear();
		setRunningUnit(chatId, undefined);
	});

	// plan 002 part 9: prepareUnitCutDuringBreak returns without preparing while setRunningUnit(chatId, 2) is set, and prepares after it is cleared
	it("skips preparation while runningUnit is set and prepares once cleared", async () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "n1", title: "Node 1" },
				{ id: "n2", title: "Node 2" },
			],
			edges: [{ from: "n1", to: "n2" }],
			version: 1,
			units: [
				{ id: "u1", title: "Unit 1", nodeIds: ["n1"] },
				{ id: "u2", title: "Unit 2", nodeIds: ["n2"] },
			],
		};
		const store = makeChatStore({
			id: chatId,
			title: "Test",
			createdAt: "2026-11-21T00:00:00.000Z",
			updatedAt: "2026-11-21T00:00:00.000Z",
			tree,
			messages: [userMsg("m1", T0), teachQuizMsg("m2", "c1", "n1", T0 + 1000)],
		});
		const zeroUsage: Usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		let calls = 0;
		const deps: CompactionDeps = {
			chatStore: store,
			engine: {} as CompactionDeps["engine"],
			modelId: "test:model",
			kind: "teach",
			thresholdTokens: 100_000,
			systemPromptTokens: 100,
			summarize: async () => {
				calls++;
				return {
					summary: JSON.stringify({
						learnerWide: "steady",
						commitments: "",
						nodes: [{ nodeId: "n1", learned: "done", errorsCorrected: "", openPoints: "" }],
					}),
					usage: zeroUsage,
				};
			},
		};

		setRunningUnit(chatId, 2);
		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 0);
		assert.equal(preparedJudgments.has(chatId), false);

		setRunningUnit(chatId, undefined);
		await prepareUnitCutDuringBreak(deps, chatId);
		assert.equal(calls, 1);
		assert.equal(preparedJudgments.has(chatId), true);
	});
});
