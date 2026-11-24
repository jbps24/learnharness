import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { LESSON_RECORD_HEADER, type LessonJudgment } from "../src/core/contracts/chat.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import {
	newUserMessage,
	type ChatRecord,
	type ChatSettings,
	type ChatStore,
	type ChatSummary,
	type ExtractionRunUsage,
	type ImageSnapshot,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
	type SideChatThread,
	type TurnUsage,
} from "../src/core/index.ts";
import { recordFacts, renderLessonRecord } from "../src/core/lesson-record.ts";
import { newestLessonRecord } from "../src/core/units.ts";
import type { CompactionDeps } from "../src/server/compaction.ts";
import { runUnitCut } from "../src/server/unit-cut.ts";

function createMemoryChatStore(): ChatStore {
	const records = new Map<string, ChatRecord>();
	let seq = 0;

	return {
		createChat(title: string, kind?: "practice"): ChatRecord {
			const id = `chat_${++seq}`;
			const now = new Date().toISOString();
			const record: ChatRecord = {
				id,
				title,
				createdAt: now,
				updatedAt: now,
				messages: [],
				...(kind ? { kind } : {}),
			};
			records.set(id, record);
			return structuredClone(record);
		},
		getChat(id: string): ChatRecord | null {
			const record = records.get(id);
			return record ? structuredClone(record) : null;
		},
		listChats(): ChatSummary[] {
			return [...records.values()].map((r) => ({
				id: r.id,
				title: r.title,
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				kind: r.kind ?? "teach",
				messageCount: r.messages.length,
				phase: "teach",
				pendingQuestion: false,
				pendingProblem: false,
				settings: r.settings,
			}));
		},
		saveMessages(id: string, messages: LhMessage[]): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			record.messages = structuredClone(messages);
			record.updatedAt = new Date().toISOString();
		},
		saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			record.imageSnapshots = { ...(record.imageSnapshots ?? {}), [snapshotId]: structuredClone(image) };
		},
		saveTree(id: string, tree: PlanTree): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			record.tree = structuredClone(tree);
		},
		appendTurnUsage(id: string, entry: TurnUsage): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			const turns = record.turns ?? [];
			if (!turns.some((t) => t.id === entry.id)) {
				record.turns = [...turns, structuredClone(entry)];
			}
		},
		appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			const extractions = record.extractions ?? [];
			if (!extractions.some((e) => e.startedAt === entry.startedAt)) {
				record.extractions = [...extractions, structuredClone(entry)];
			}
		},
		saveSettings(id: string, settings: ChatSettings): void {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			record.settings = structuredClone(settings);
		},
		renameChat(id: string, title: string): ChatRecord {
			const record = records.get(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			record.title = title;
			return structuredClone(record);
		},
		deleteChat(id: string): boolean {
			return records.delete(id);
		},
		updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): SideChatThread[] | null {
			const record = records.get(id);
			if (!record) return null;
			record.sideChats = update(structuredClone(record.sideChats ?? []));
			return structuredClone(record.sideChats);
		},
	};
}

const ZERO_USAGE: Usage = {
	input: 100,
	output: 30,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 130,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantTeachCall(id: string, callId: string, nodeId: string, text = "Check."): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { nodeId, type: "check", question: "Q?" } },
		],
		timestamp: 1,
	} as never;
}

function toolResultFor(id: string, callId: string, questionText = "Q?"): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text: "ok" }],
		details: {
			kind: "quiz",
			questionText,
			dontKnow: false,
			answers: [{ label: "A", value: "A", index: 1 }],
			correct: true,
			answeredAt: "2026-11-20T00:00:00.000Z",
		},
		isError: false,
		timestamp: 2,
	} as never;
}

describe("orphan nodes with judgment entries and no check lines", () => {
	// plan 001 part 3 Result: "Taught, no longer in the plan" lists removed nodes with a judgment entry but no check lines as "- (<id>)", while judgment text renders only under "The learner, per node"
	it("lists judgment-only removed nodes under Taught, no longer in the plan and renders judgment text only under The learner, per node", () => {
		const tree: PlanTree = {
			version: 1,
			nodes: [
				{ id: "n1", title: "Limits" },
				{ id: "n2", title: "Derivatives" },
			],
			edges: [{ from: "n1", to: "n2" }],
			units: [
				{ id: "u1", title: "Foundations", nodeIds: ["n1"] },
				{ id: "u2", title: "Rates", nodeIds: ["n2"] },
			],
		};
		const messages: LhMessage[] = [
			assistantTeachCall("a_old", "c_old", "old-with-check"),
			toolResultFor("r_old", "c_old", "Old check"),
			assistantTeachCall("a1", "c1", "n1"),
			toolResultFor("r1", "c1", "Limits check"),
		];
		const judgment: LessonJudgment = {
			learnerWide: "Prefers concrete examples.",
			commitments: "",
			nodes: {
				n1: { learned: "Understands limits.", errorsCorrected: "", openPoints: "" },
				"old-judgment-only": {
					learned: "Judgment-only orphan learned.",
					errorsCorrected: "Corrected orphan misconception.",
					openPoints: "Still open on orphan.",
				},
				"old-with-check": {
					learned: "Orphan with check learned.",
					errorsCorrected: "",
					openPoints: "",
				},
			},
		};

		const facts = recordFacts(tree, messages, ["u1"], "u2", Object.keys(judgment.nodes));
		const rendered = renderLessonRecord(facts, judgment);

		assert.ok(rendered.startsWith(LESSON_RECORD_HEADER));
		const taughtPos = rendered.indexOf("## Taught, no longer in the plan");
		const positionPos = rendered.indexOf("## Current position");
		const perNodePos = rendered.indexOf("## The learner, per node");
		assert.ok(taughtPos >= 0);
		assert.ok(positionPos > taughtPos);
		assert.ok(perNodePos > positionPos);

		const taughtSection = rendered.slice(taughtPos, positionPos);
		assert.ok(taughtSection.includes("- (old-judgment-only)"));
		assert.ok(taughtSection.includes('- (old-with-check)\n    · check — "Old check" — right'));
		assert.equal(taughtSection.includes("(n1)"), false);
		assert.equal(taughtSection.match(/\(old-with-check\)/g)?.length, 1);
		assert.equal(taughtSection.includes("Judgment-only orphan learned."), false);
		assert.equal(taughtSection.includes("Corrected orphan misconception."), false);
		assert.equal(taughtSection.includes("Still open on orphan."), false);

		const perNodeSection = rendered.slice(perNodePos);
		assert.ok(perNodeSection.indexOf("### Limits (n1)") < perNodeSection.indexOf("### (old-judgment-only)"));
		assert.ok(perNodeSection.includes("Learned: Judgment-only orphan learned."));
		assert.ok(perNodeSection.includes("Errors corrected: Corrected orphan misconception."));
		assert.ok(perNodeSection.includes("Open points: Still open on orphan."));
	});

	// plan 001 part 3 Result & part 5: runUnitCut passes the merged judgment's node ids to recordFacts
	it("runUnitCut includes removed nodes from prior and current judgment without check lines in Taught, no longer in the plan", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("orphan judgment unit cut");
		const tree: PlanTree = {
			version: 1,
			nodes: [
				{ id: "n1", title: "Node One" },
				{ id: "n2", title: "Node Two" },
				{ id: "n3", title: "Node Three" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
			],
			units: [
				{ id: "u1", title: "Unit One", nodeIds: ["n1"] },
				{ id: "u2", title: "Unit Two", nodeIds: ["n2"] },
				{ id: "u3", title: "Unit Three", nodeIds: ["n3"] },
			],
		};
		store.saveTree(chat.id, tree);

		const u0 = newUserMessage("start");
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const r1 = toolResultFor("r1", "c1", "N1 check");
		const a2 = assistantTeachCall("a2", "c2", "n2", "Starting unit 2");
		const r2 = toolResultFor("r2", "c2", "N2 check");
		// Unanswered teach call for a removed node: in taughtIds / merged judgment, no checkLines entry.
		const aStretchOrphan = assistantTeachCall("a_stretch_orphan", "c_so", "stretch-orphan", "Stretch orphan");
		const priorDetails: LessonRecordDetails = {
			firstKeptMessageId: a2.id,
			finishedUnitIds: ["u1"],
			currentUnitId: "u2",
			judgment: {
				learnerWide: "Likes examples.",
				commitments: "",
				nodes: {
					n1: { learned: "Mastered n1.", errorsCorrected: "", openPoints: "" },
					"prior-orphan": { learned: "Prior orphan learned.", errorsCorrected: "", openPoints: "" },
				},
			},
			at: "2026-11-20T00:00:00.000Z",
		};
		const priorMarker: LhMarkerMessage = {
			id: "lr_prev",
			role: "custom",
			customType: "lesson-record",
			content: `${LESSON_RECORD_HEADER}\n\nprior`,
			display: true,
			details: priorDetails,
			timestamp: 10,
		};
		const a3 = assistantTeachCall("a3", "c3", "n3", "Starting unit 3");
		store.saveMessages(chat.id, [u0, a1, r1, a2, r2, aStretchOrphan, priorMarker, a3]);

		const deps: CompactionDeps = {
			chatStore: store,
			engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
			modelId: "faux:test",
			kind: "teach",
			thresholdTokens: 150_000,
			systemPromptTokens: 100,
			summarize: async () => ({
				summary: JSON.stringify({
					learnerWide: "Likes examples.",
					commitments: "",
					nodes: [
						{ nodeId: "n2", learned: "Learned n2.", errorsCorrected: "", openPoints: "" },
						{ nodeId: "stretch-orphan", learned: "Stretch orphan learned.", errorsCorrected: "", openPoints: "" },
					],
				}),
				usage: ZERO_USAGE,
			}),
		};

		const result = await runUnitCut(deps, chat.id);
		assert.equal(result, "done");

		const latest = newestLessonRecord(store.getChat(chat.id)!.messages)!;
		const taughtPos = latest.content.indexOf("## Taught, no longer in the plan");
		const positionPos = latest.content.indexOf("## Current position");
		const perNodePos = latest.content.indexOf("## The learner, per node");
		assert.ok(taughtPos >= 0);
		assert.ok(positionPos > taughtPos);
		assert.ok(perNodePos > positionPos);

		const taughtSection = latest.content.slice(taughtPos, positionPos);
		assert.ok(taughtSection.includes("- (prior-orphan)"));
		assert.ok(taughtSection.includes("- (stretch-orphan)"));
		assert.equal(taughtSection.includes("Prior orphan learned."), false);
		assert.equal(taughtSection.includes("Stretch orphan learned."), false);

		const perNodeSection = latest.content.slice(perNodePos);
		assert.ok(perNodeSection.includes("### (prior-orphan)\nLearned: Prior orphan learned."));
		assert.ok(perNodeSection.includes("### (stretch-orphan)\nLearned: Stretch orphan learned."));
		assert.ok(perNodeSection.indexOf("### Node Two (n2)") < perNodeSection.indexOf("### (prior-orphan)"));
	});
});
