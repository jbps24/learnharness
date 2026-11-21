import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLAUDE_CODE_PROVIDER,
	cliContextWindowOf,
	estimateContextTokens,
	failedResponseAtEnd,
	lastAssistantUsageIndex,
	measuredContextTokens,
	type LessonRecordDetails,
	type LhMessage,
} from "../src/core/index.ts";
import { CLAUDE_CODE_API } from "../src/agent/claude-code/constants.ts";
import { SIDE_CONTEXT_BUDGET_ERROR, sideBudgetRetryDrops } from "../src/server/side-context-budget.ts";

const userMsg = (id: string, text = "hello"): LhMessage => ({
	id,
	role: "user",
	content: text,
	timestamp: 1,
});

const usageAssistant = (id: string, total: number): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input: total - 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: total,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	}) as never;

const claudeAssistant = (id: string, cliContextWindow: number): LhMessage =>
	({
		id,
		role: "assistant",
		provider: CLAUDE_CODE_PROVIDER,
		api: CLAUDE_CODE_API,
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		cliContextWindow,
		timestamp: 2,
	}) as never;

const errorAssistant = (id: string): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: "boom",
		timestamp: 2,
	}) as never;

const localSideBudgetFailure = (id: string): LhMessage =>
	({
		id,
		role: "assistant",
		provider: CLAUDE_CODE_PROVIDER,
		api: CLAUDE_CODE_API,
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			reasoning: 0,
			cacheWrite1h: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: SIDE_CONTEXT_BUDGET_ERROR,
		timestamp: 2,
	}) as never;

const lessonRecordMarker = (id: string, firstKeptMessageId: string): LhMessage => {
	const details: LessonRecordDetails = {
		firstKeptMessageId,
		finishedUnitIds: ["u1"],
		currentUnitId: "u2",
		judgment: { learnerWide: "", commitments: "", nodes: {} },
		at: "2026-11-20T00:00:00.000Z",
	};
	return {
		id,
		role: "custom",
		customType: "lesson-record",
		content: "[LESSON RECORD]",
		display: true,
		details,
		timestamp: 10,
	};
};

const unitsNoteMarker = (id: string): LhMessage => ({
	id,
	role: "custom",
	customType: "units-note",
	content: "Unit 2 starting",
	display: false,
	details: {},
	timestamp: 11,
});

describe("usage anchor, meter, and CLI window stop at lesson-record markers", () => {
	// plan 001 part 4, rule 2: lastAssistantUsageIndex stops at a lesson-record marker
	it("lastAssistantUsageIndex ignores assistant usage before a lesson-record marker", () => {
		const msgs = [usageAssistant("a1", 40_000), lessonRecordMarker("r1", "u1"), userMsg("u1", "tail")];
		assert.equal(lastAssistantUsageIndex(msgs), null);
		assert.equal(estimateContextTokens(msgs).lastUsageIndex, null);
	});

	// plan 001 part 4, rule 2: lastAssistantUsageIndex uses assistant usage after a lesson-record marker
	it("lastAssistantUsageIndex and estimateContextTokens use assistant usage after a lesson-record marker", () => {
		const msgs = [
			usageAssistant("a1", 40_000),
			lessonRecordMarker("r1", "u1"),
			userMsg("u1", "tail"),
			usageAssistant("a2", 12_000),
		];
		assert.equal(lastAssistantUsageIndex(msgs), 3);
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, 3);
		assert.equal(est.usageTokens, 12_000);
	});

	// plan 001 part 4, rule 2: measuredContextTokens stops at a lesson-record marker
	it("measuredContextTokens returns null when only pre-record assistant measurements exist", () => {
		const msgs = [usageAssistant("a1", 25_000), lessonRecordMarker("r1", "u1"), userMsg("u1", "tail")];
		assert.equal(measuredContextTokens(msgs), null);
	});

	// plan 001 part 4, rule 2: measuredContextTokens uses measurement after a lesson-record marker
	it("measuredContextTokens returns the measurement from an assistant after a lesson-record marker", () => {
		const msgs = [
			usageAssistant("a1", 25_000),
			lessonRecordMarker("r1", "u1"),
			userMsg("u1", "tail"),
			usageAssistant("a2", 9_000),
		];
		assert.equal(measuredContextTokens(msgs), 9_000);
	});

	// plan 001 part 4, rule 2: cliContextWindowOf stops at a lesson-record marker
	it("cliContextWindowOf returns null when only pre-record CLI window reports exist", () => {
		const msgs = [claudeAssistant("a1", 200_000), lessonRecordMarker("r1", "u1"), userMsg("u1", "tail")];
		assert.equal(cliContextWindowOf(msgs), null);
	});

	// plan 001 part 4, rule 2: cliContextWindowOf uses window reported after a lesson-record marker
	it("cliContextWindowOf returns the CLI window reported after a lesson-record marker", () => {
		const msgs = [
			claudeAssistant("a1", 200_000),
			lessonRecordMarker("r1", "u1"),
			userMsg("u1", "tail"),
			claudeAssistant("a2", 180_000),
		];
		assert.deepEqual(cliContextWindowOf(msgs), {
			model: `${CLAUDE_CODE_PROVIDER}:claude-sonnet-4-5`,
			tokens: 180_000,
		});
	});
});

describe("failedResponseAtEnd and sideBudgetRetryDrops with lesson-record and units-note markers", () => {
	// plan 001 part 4, files (input-events.ts): failedResponseAtEnd skips lesson-record and units-note markers
	it("failedResponseAtEnd skips trailing lesson-record and units-note markers", () => {
		const err = errorAssistant("a_err");
		assert.equal(failedResponseAtEnd([userMsg("u1"), err, lessonRecordMarker("r1", "u1")])?.id, "a_err");
		assert.equal(failedResponseAtEnd([userMsg("u1"), err, unitsNoteMarker("un1")])?.id, "a_err");
		assert.equal(failedResponseAtEnd([userMsg("u1"), usageAssistant("a_ok", 100), lessonRecordMarker("r1", "u1")]), undefined);
	});

	// plan 001 part 4, files (side-context-budget.ts): sideBudgetRetryDrops accepts appended lesson-record markers
	it("sideBudgetRetryDrops accepts appended lesson-record markers like compaction markers", () => {
		const before = [userMsg("u1"), localSideBudgetFailure("a_fail")];
		const after = [...before, lessonRecordMarker("r1", "u1")];
		const drops = sideBudgetRetryDrops(before, after);
		assert.ok(drops);
		assert.deepEqual([...drops], ["a_fail"]);
	});
});
