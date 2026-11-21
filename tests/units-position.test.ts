import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LessonRecordDetails } from "../src/core/contracts/chat.ts";
import { derivePlanStatusesLh, type PlanTree } from "../src/core/contracts/plan.ts";
import { type LhMarkerMessage, type LhMessage, nativeInputCause } from "../src/core/native-messages.ts";
import {
	currentUnitIndex,
	finishedUnitIds,
	newestLessonRecord,
	teachTags,
	unitCutDue,
	unitIndexOf,
} from "../src/core/units.ts";

function makeAssistantCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
	extra?: Partial<LhMessage>,
): LhMessage {
	const assertArgs: (v: Record<string, unknown>) => asserts v is Record<string, never> = () => {};
	assertArgs(args);
	const assertExtra: (
		v: Partial<LhMessage> | undefined,
	) => asserts v is Pick<Partial<LhMessage>, "lhQuestions"> | undefined = () => {};
	assertExtra(extra);
	const msg: AssistantMessage & { id: string } = {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `tc_${id}`, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	return { ...msg, ...extra } as LhMessage;
}

function makeUserMsg(id: string, text = "ok"): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 };
}

function makePluginQuestionMsg(
	id: string,
	variant: "teach" | "probe",
	nodeId?: string,
): LhMessage {
	const toolCallId = `tc_${id}`;
	const toolName = variant === "teach" ? "plugin_teach_q" : "plugin_probe_q";
	const input =
		variant === "teach"
			? { type: "check", nodeId: nodeId!, question: "Q?", payload: {} }
			: { question: "Q?", payload: {} };
	const assertInput: (
		v: typeof input,
	) => asserts v is
		| { question: string; payload: Record<string, never>; type?: never; nodeId?: never }
		| { question: string; payload: Record<string, never>; type: "predict" | "check"; nodeId: string } = () => {};
	assertInput(input);
	return makeAssistantCall(id, toolName, input, {
		lhQuestions: {
			"0": {
				protocolVersion: 1,
				pluginId: "test-plugin",
				typeId: "custom",
				label: "Custom",
				variant,
				questionId: `q_${id}`,
				contractVersion: 1,
				occurrence: { messageId: id, contentIndex: 0, toolCallId, toolName },
				input,
				questionSchema: { type: "object", properties: {}, additionalProperties: false },
				answerSchema: { type: "object", properties: {}, additionalProperties: false },
				showThinking: false,
				requiresAnswerRefinement: false,
			},
		},
	});
}

function makeLessonRecordMarker(
	id: string,
	details: LessonRecordDetails,
): LhMarkerMessage {
	return {
		id,
		role: "custom",
		customType: "lesson-record",
		content: "",
		display: true,
		details,
		timestamp: 1,
	};
}

const unitTree: PlanTree = {
	nodes: [
		{ id: "n0", title: "Node 0" },
		{ id: "n1", title: "Node 1" },
		{ id: "n2", title: "Node 2" },
	],
	edges: [
		{ from: "n0", to: "n1" },
		{ from: "n1", to: "n2" },
	],
	units: [
		{ id: "u0", title: "Unit 0", nodeIds: ["n0"] },
		{ id: "u1", title: "Unit 1", nodeIds: ["n1"] },
		{ id: "u2", title: "Unit 2", nodeIds: ["n2"] },
	],
	version: 1,
};

const unitlessTree: PlanTree = {
	nodes: [
		{ id: "n0", title: "Node 0" },
		{ id: "n1", title: "Node 1" },
	],
	edges: [{ from: "n0", to: "n1" }],
	version: 1,
};

describe("teachTags", () => {
	// plan 001 part 2: teachTags returns empty for empty transcript and ignores non-teach calls
	it("returns [] for empty messages and ignores probe, recall, ask_user_question, and untagged calls", () => {
		assert.deepEqual(teachTags([]), []);
		const messages: LhMessage[] = [
			makeUserMsg("u1"),
			makeAssistantCall("a1", "probe", { question: "Q?" }),
			makeAssistantCall("a2", "recall", { question: "Q?" }),
			makeAssistantCall("a3", "ask_user_question", { question: "Q?" }),
			makeAssistantCall("a4", "quiz", { question: "Q?" }),
			makePluginQuestionMsg("a5", "probe"),
		];
		assert.deepEqual(teachTags(messages), []);
	});

	// plan 001 part 2: every teach-tagged quiz/explain or posed plugin teach call in transcript order, including orphaned nodeIds
	it("collects quiz, explain, and posed plugin teach calls in transcript order, including orphaned nodeIds, consistent with derivePlanStatusesLh", () => {
		const messages: LhMessage[] = [
			makeUserMsg("u1"),
			makeAssistantCall("a1", "quiz", { nodeId: "n0" }),
			makeAssistantCall("a2", "explain", { nodeId: "ghost" }),
			makePluginQuestionMsg("a3", "teach", "n1"),
		];
		assert.deepEqual(teachTags(messages), [
			{ nodeId: "n0", messageId: "a1", messageIndex: 1 },
			{ nodeId: "ghost", messageId: "a2", messageIndex: 2 },
			{ nodeId: "n1", messageId: "a3", messageIndex: 3 },
		]);
		const statuses = derivePlanStatusesLh(unitTree, messages);
		assert.equal(statuses.current, "n1");
		assert.deepEqual([...statuses.visited], ["n0"]);
	});
});

describe("unitIndexOf and currentUnitIndex", () => {
	// plan 001 part 2: unitIndexOf returns null when tree has no units or nodeId is unknown
	it("unitIndexOf returns null for unitless trees or unknown nodeIds, and 0-based index for known nodes", () => {
		assert.equal(unitIndexOf(unitlessTree, "n0"), null);
		assert.equal(unitIndexOf(unitTree, "ghost"), null);
		assert.equal(unitIndexOf(unitTree, "n0"), 0);
		assert.equal(unitIndexOf(unitTree, "n1"), 1);
		assert.equal(unitIndexOf(unitTree, "n2"), 2);
	});

	// plan 001 part 2: currentUnitIndex is null when tree has no units, 0 when no valid tag exists
	it("currentUnitIndex returns null without units, and 0 when no valid tag exists", () => {
		assert.equal(currentUnitIndex(unitlessTree, [makeAssistantCall("a1", "quiz", { nodeId: "n0" })]), null);
		assert.equal(currentUnitIndex(unitTree, []), 0);
		assert.equal(currentUnitIndex(unitTree, [makeAssistantCall("a1", "quiz", { nodeId: "ghost" })]), 0);
	});

	// plan 001 part 2: revisit tag into unit 0 while current unit is 2 -> currentUnitIndex stays 2
	it("currentUnitIndex takes the maximum unitIndexOf over valid tags so revisiting unit 0 keeps unit 2", () => {
		const messages: LhMessage[] = [
			makeAssistantCall("a1", "quiz", { nodeId: "n0" }),
			makeAssistantCall("a2", "quiz", { nodeId: "n2" }),
			makeAssistantCall("a3", "explain", { nodeId: "n0" }),
		];
		assert.equal(currentUnitIndex(unitTree, messages), 2);
	});
});

describe("newestLessonRecord, finishedUnitIds, and unitCutDue", () => {
	// plan 001 part 2: newestLessonRecord requires firstKeptMessageId to name an existing message
	it("ignores lesson-record markers whose firstKeptMessageId does not exist and picks the newest valid one", () => {
		const m1 = makeUserMsg("m1");
		const m2 = makeUserMsg("m2");
		const rec1 = makeLessonRecordMarker("lr1", {
			firstKeptMessageId: "m1",
			finishedUnitIds: ["u0"],
			currentUnitId: "u1",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-20T00:00:00.000Z",
		});
		const recValid2 = makeLessonRecordMarker("lr3", {
			firstKeptMessageId: "m2",
			finishedUnitIds: ["u0", "u1"],
			currentUnitId: "u2",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-20T00:30:00.000Z",
		});
		const recDangling = makeLessonRecordMarker("lr2", {
			firstKeptMessageId: "missing-msg",
			finishedUnitIds: ["u0", "u1"],
			currentUnitId: "u2",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-20T01:00:00.000Z",
		});

		assert.equal(newestLessonRecord([m1]), null);
		assert.deepEqual(finishedUnitIds([m1]), []);
		assert.equal(newestLessonRecord([m1, recDangling]), null);
		assert.deepEqual(finishedUnitIds([m1, recDangling]), []);

		const newest = newestLessonRecord([m1, rec1, m2, recValid2, recDangling]);
		assert.equal(newest?.id, "lr3");
		assert.deepEqual(finishedUnitIds([m1, rec1, m2, recValid2, recDangling]), ["u0", "u1"]);
	});

	// plan 001 part 2: tree without units -> unitCutDue is false; otherwise currentUnitIndex > finishedUnitIds.length
	it("unitCutDue is false without units, false when currentUnitIndex <= finishedUnitIds.length, and true when greater", () => {
		assert.equal(unitCutDue(unitlessTree, [makeAssistantCall("a1", "quiz", { nodeId: "n1" })]), false);
		assert.equal(unitCutDue(unitTree, []), false);

		const tagU1 = makeAssistantCall("a1", "quiz", { nodeId: "n1" });
		assert.equal(unitCutDue(unitTree, [tagU1]), true);

		const recU0 = makeLessonRecordMarker("lr1", {
			firstKeptMessageId: "a1",
			finishedUnitIds: ["u0"],
			currentUnitId: "u1",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-20T00:00:00.000Z",
		});
		assert.equal(unitCutDue(unitTree, [tagU1, recU0]), false);

		const tagU2 = makeAssistantCall("a2", "quiz", { nodeId: "n2" });
		assert.equal(unitCutDue(unitTree, [tagU1, recU0, tagU2]), true);
	});
});

describe("nativeInputCause for unit markers", () => {
	// plan 001 part 2: "lesson-record" and "units-note" are in the neutral list at the classifier
	it("classifies lesson-record and units-note markers as neutral", () => {
		const rec = makeLessonRecordMarker("lr1", {
			firstKeptMessageId: "m1",
			finishedUnitIds: ["u0"],
			currentUnitId: "u1",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-20T00:00:00.000Z",
		});
		const note: LhMarkerMessage = {
			id: "un1",
			role: "custom",
			customType: "units-note",
			content: "",
			display: true,
			timestamp: 1,
			details: {},
		};
		assert.equal(nativeInputCause(rec as never, []), "neutral");
		assert.equal(nativeInputCause(note as never, []), "neutral");
	});
});
