import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import {
	LESSON_RECORD_HEADER,
	newCompactionMarker,
	newUserMessage,
	toLlmMessages,
	type ChatRecord,
	type ChatSettings,
	type ChatStore,
	type ChatSummary,
	type ExtractionRunUsage,
	type ImageSnapshot,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
	type PlanTree,
	type SideChatThread,
	type TurnUsage,
} from "../src/core/index.ts";
import { newestLessonRecord } from "../src/core/units.ts";
import { awaitCompaction, ensureCompacted, kickCompaction, type CompactionDeps } from "../src/server/compaction.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { runUnitCut } from "../src/server/unit-cut.ts";

// ── in-memory ChatStore ─────────────────────────────────────────────────────

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

// ── fixtures ────────────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
	input: 120,
	output: 40,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 160,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function threeUnitTree(): PlanTree {
	return {
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
}

function assistantTeachCall(id: string, callId: string, nodeId: string, text = "Let's check."): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { nodeId, question: "Q?" } },
		],
		timestamp: 1,
	} as never;
}

function toolResultFor(id: string, callId: string, text = "correct"): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text }],
		details: { questionText: "Q?", correct: true },
		isError: false,
		timestamp: 2,
	} as never;
}

function customNote(id: string, customType: LhMarkerMessage["customType"], content: string): LhMarkerMessage {
	return {
		id,
		role: "custom",
		customType,
		content,
		display: false,
		details: {},
		timestamp: 3,
	};
}

function validJudgmentJson(nodeIds: string[], note = "solid"): string {
	return JSON.stringify({
		learnerWide: "Prefers concrete examples.",
		commitments: "",
		nodes: nodeIds.map((nodeId) => ({
			nodeId,
			learned: `Understands ${nodeId} (${note}).`,
			errorsCorrected: "",
			openPoints: "",
		})),
	});
}

function makeDeps(
	chatStore: ChatStore,
	overrides: Partial<CompactionDeps> = {},
): CompactionDeps {
	return {
		chatStore,
		engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
		modelId: "faux:test",
		kind: "teach",
		thresholdTokens: 150_000,
		systemPromptTokens: 100,
		...overrides,
	};
}

const activeTurns: string[] = [];
afterEach(() => {
	for (const id of activeTurns.splice(0)) endTurn(id);
});

// ── tests ───────────────────────────────────────────────────────────────────

describe("runUnitCut", () => {
	// plan 001 part 5 rule 1: isTurnRunning(chatId) -> "skipped"
	it('returns "skipped" without calling summarizer when a turn is running', async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("running turn");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			toolResultFor("r1", "c1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		let calls = 0;
		beginTurn(chat.id);
		activeTurns.push(chat.id);

		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async () => {
					calls++;
					return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(result, "skipped");
		assert.equal(calls, 0);
		assert.equal(newestLessonRecord(store.getChat(chat.id)!.messages), null);
	});

	// plan 001 part 5 rule 1: no chat, no tree, or !unitCutDue -> "skipped"
	it('returns "skipped" without calling summarizer when chat is missing, has no tree, or unitCutDue is false', async () => {
		const store = createMemoryChatStore();
		let calls = 0;
		const deps = makeDeps(store, {
			summarize: async () => {
				calls++;
				return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
			},
		});

		assert.equal(await runUnitCut(deps, "missing-chat"), "skipped");

		const noTree = store.createChat("no tree");
		store.saveMessages(noTree.id, [newUserMessage("hi"), assistantTeachCall("a1", "c1", "n1")]);
		assert.equal(await runUnitCut(deps, noTree.id), "skipped");

		const notDue = store.createChat("unit 0");
		store.saveTree(notDue.id, threeUnitTree());
		store.saveMessages(notDue.id, [newUserMessage("hi"), assistantTeachCall("a1", "c1", "n1")]);
		assert.equal(await runUnitCut(deps, notDue.id), "skipped");

		assert.equal(calls, 0);
	});

	// plan 001 part 5 rules 2, 3, 7, 8, 9 & Tests: a due cut writes one marker with the right
	// firstKeptMessageId, finishedUnitIds and currentUnitId, and the projection now starts at that message
	it("writes one lesson-record marker, records usage, emits record-changed, and starts projection at firstKeptMessageId", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("due cut");
		store.saveTree(chat.id, threeUnitTree());
		const u0 = newUserMessage("unit 1 intro");
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const r1 = toolResultFor("r1", "c1");
		const a2First = assistantTeachCall("a2_first", "c2", "n2", "Starting unit 2");
		const r2 = toolResultFor("r2", "c2");
		const a2Second = assistantTeachCall("a2_second", "c3", "n2", "More unit 2");
		store.saveMessages(chat.id, [u0, a1, r1, a2First, r2, a2Second]);

		const events: ServerEvent[] = [];
		const unsubscribe = subscribe((e) => events.push(e));
		try {
			const result = await runUnitCut(
				makeDeps(store, {
					summarize: async () => ({
						summary: validJudgmentJson(["n1"]),
						usage: ZERO_USAGE,
					}),
				}),
				chat.id,
			);
			assert.equal(result, "done");
		} finally {
			unsubscribe();
		}

		const saved = store.getChat(chat.id)!;
		const marker = newestLessonRecord(saved.messages);
		assert.ok(marker, "lesson-record marker must be written");
		assert.equal(marker.details.firstKeptMessageId, a2First.id);
		assert.deepEqual(marker.details.finishedUnitIds, ["u1"]);
		assert.equal(marker.details.currentUnitId, "u2");
		assert.equal(marker.details.model, "faux:test");
		assert.equal(typeof marker.details.tokensBefore, "number");
		assert.ok(!Number.isNaN(Date.parse(marker.details.at)));
		assert.equal(marker.details.judgment.nodes.n1?.learned, "Understands n1 (solid).");
		assert.ok(marker.content.startsWith(LESSON_RECORD_HEADER));

		const llm = toLlmMessages(saved.messages);
		const firstLlm = llm[0] as unknown as { content: string | Array<{ text?: string }> };
		const firstText =
			typeof firstLlm.content === "string" ? firstLlm.content : (firstLlm.content[0]?.text ?? "");
		assert.ok(firstText.includes(LESSON_RECORD_HEADER), "projection must be headed by the lesson-record marker");
		// The kept messages after the header start at a2First (u0, a1, r1 are dropped)
		const serializedLlm = JSON.stringify(llm);
		assert.equal(serializedLlm.includes("unit 1 intro"), false);
		assert.equal(serializedLlm.includes("Starting unit 2"), true);

		assert.equal(saved.turns?.length, 1);
		assert.equal(saved.turns![0]!.messageId, marker.id);
		assert.equal(saved.turns![0]!.model, "faux:test");
		assert.equal(saved.turns![0]!.steps[0]!.inputTokens, ZERO_USAGE.input);

		assert.ok(
			events.some((e) => e.type === "record-changed" && e.chatId === chat.id),
			"must emit record-changed",
		);
	});

	// plan 001 part 5 rules 3, 4, 7: span [s, k) from previous kept index, taughtIds includes orphans, mergeJudgment preserves prior nodes
	it("starts span at previous record kept index, includes orphan teach tags in taughtIds, and merges prior judgment", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("second cut");
		store.saveTree(chat.id, threeUnitTree());

		const u0 = newUserMessage("unit 1 message SHOULD NOT BE IN SPAN");
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const r1 = toolResultFor("r1", "c1");
		const a2 = assistantTeachCall("a2", "c2", "n2", "unit 2 first");
		const r2 = toolResultFor("r2", "c2");
		const aOrphan = assistantTeachCall("a_orphan", "c_orp", "orphan-node", "orphan teach");
		const rOrphan = toolResultFor("r_orp", "c_orp");
		const a2Repeat = assistantTeachCall("a2_rep", "c2b", "n2", "unit 2 repeat");
		const priorDetails: LessonRecordDetails = {
			firstKeptMessageId: a2.id,
			finishedUnitIds: ["u1"],
			currentUnitId: "u2",
			judgment: {
				learnerWide: "Likes visual intuition.",
				commitments: "Revisit n1 later.",
				nodes: {
					n1: { learned: "Mastered n1.", errorsCorrected: "", openPoints: "" },
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
		const a3 = assistantTeachCall("a3", "c3", "n3", "unit 3 starts");
		store.saveMessages(chat.id, [u0, a1, r1, a2, r2, aOrphan, rOrphan, a2Repeat, priorMarker, a3]);

		let capturedPrompt = "";
		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async (prompt) => {
					capturedPrompt = prompt;
					return {
						summary: validJudgmentJson(["n2", "orphan-node"]),
						usage: ZERO_USAGE,
					};
				},
			}),
			chat.id,
		);

		assert.equal(result, "done");
		assert.equal(capturedPrompt.includes("unit 1 message SHOULD NOT BE IN SPAN"), false);
		assert.equal(capturedPrompt.includes("unit 2 first"), true);
		assert.equal(capturedPrompt.includes("orphan-node"), true);

		const latest = newestLessonRecord(store.getChat(chat.id)!.messages)!;
		assert.deepEqual(latest.details.finishedUnitIds, ["u1", "u2"]);
		assert.equal(latest.details.currentUnitId, "u3");
		assert.equal(latest.details.firstKeptMessageId, a3.id);
		assert.equal(latest.details.judgment.nodes.n1?.learned, "Mastered n1.");
		assert.equal(latest.details.judgment.nodes.n2?.learned, "Understands n2 (solid).");
		assert.equal(latest.details.judgment.nodes["orphan-node"]?.learned, "Understands orphan-node (solid).");
	});

	// plan 001 part 5 Tests: a conversion-style record where the current unit is 2 -> finishedUnitIds has 2 ids
	it("conversion-style record at unit index 2 writes two finishedUnitIds", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("conversion");
		store.saveTree(chat.id, threeUnitTree());
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const a3 = assistantTeachCall("a3", "c3", "n3");
		store.saveMessages(chat.id, [newUserMessage("hi"), a1, a3]);

		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async () => ({
					summary: validJudgmentJson(["n1"]),
					usage: ZERO_USAGE,
				}),
			}),
			chat.id,
		);

		assert.equal(result, "done");
		const marker = newestLessonRecord(store.getChat(chat.id)!.messages)!;
		assert.deepEqual(marker.details.finishedUnitIds, ["u1", "u2"]);
		assert.equal(marker.details.currentUnitId, "u3");
		assert.equal(marker.details.firstKeptMessageId, a3.id);
	});

	// plan 001 part 5 rule 5: raw serializeForSummary(span minus compaction/lesson-record/units-note markers)
	it("strips compaction, lesson-record, and units-note markers from raw span prompt input", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("strip markers");
		store.saveTree(chat.id, threeUnitTree());
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const cMarker = newCompactionMarker("COMPACTION_MARKER_SECRET", {
			firstKeptMessageId: a1.id,
			tokensBefore: 1000,
			at: "2026-11-20T00:00:00.000Z",
		});
		const uNote = customNote("un1", "units-note", "UNITS_NOTE_SECRET");
		const lrNote = customNote("lr1", "lesson-record", "LESSON_RECORD_SECRET");
		const a2 = assistantTeachCall("a2", "c2", "n2");
		store.saveMessages(chat.id, [newUserMessage("start"), a1, cMarker, uNote, lrNote, a2]);

		let capturedPrompt = "";
		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async (prompt) => {
					capturedPrompt = prompt;
					return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(result, "done");
		assert.equal(capturedPrompt.includes("COMPACTION_MARKER_SECRET"), false);
		assert.equal(capturedPrompt.includes("UNITS_NOTE_SECRET"), false);
		assert.equal(capturedPrompt.includes("LESSON_RECORD_SECRET"), false);
	});

	// plan 001 spec choice 3 & part 5 rule 5: the limit is ceil(chars / 4) <= thresholdTokens
	it('an oversized span fails and a span within thresholdTokens is summarized', async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("default fit");
		store.saveTree(chat.id, threeUnitTree());
		const before = [
			newUserMessage(`big ${"x".repeat(4_000)}`),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		];
		store.saveMessages(chat.id, before);

		let calls = 0;
		const summarize = async () => {
			calls++;
			return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
		};
		const tooSmall = await runUnitCut(makeDeps(store, { thresholdTokens: 200, summarize }), chat.id);
		assert.equal(tooSmall, "failed");
		assert.equal(calls, 0);
		assert.equal(store.getChat(chat.id)!.messages.length, before.length);

		const roomy = await runUnitCut(makeDeps(store, { thresholdTokens: 500_000, summarize }), chat.id);
		assert.equal(roomy, "done");
		assert.equal(calls, 1);
	});

	// plan 001 part 5 rule 6 & Tests: a first invalid then valid JSON answer -> one retry, then success
	it("retries once with rejection problems when first answer is invalid JSON and succeeds on valid retry", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("retry success");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		const prompts: string[] = [];
		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async (prompt) => {
					prompts.push(prompt);
					if (prompts.length === 1) {
						return { summary: "not json at all", usage: ZERO_USAGE };
					}
					return { summary: validJudgmentJson(["n1"], "retried"), usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(result, "done");
		assert.equal(prompts.length, 2);
		assert.ok(prompts[1]!.includes("\n\nYour previous answer was rejected:\n- "));
		assert.ok(prompts[1]!.includes("\nReturn the corrected JSON object only."));
		const marker = newestLessonRecord(store.getChat(chat.id)!.messages);
		assert.ok(marker);
		assert.equal(marker.details.judgment.nodes.n1?.learned, "Understands n1 (retried).");
	});

	// plan 001 part 5 rule 6 & Tests: two invalid answers -> no marker, and "failed"
	it('returns "failed" with no marker when two answers are invalid JSON', async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("two invalid");
		store.saveTree(chat.id, threeUnitTree());
		const before = [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		];
		store.saveMessages(chat.id, before);

		let calls = 0;
		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async () => {
					calls++;
					return { summary: "{invalid", usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(result, "failed");
		assert.equal(calls, 2);
		assert.equal(newestLessonRecord(store.getChat(chat.id)!.messages), null);
		assert.equal(store.getChat(chat.id)!.messages.length, before.length);
	});

	// plan 001 part 5 rule 6: summarizer throw -> "failed" with record untouched
	it('returns "failed" with no marker when summarizer throws', async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("throw");
		store.saveTree(chat.id, threeUnitTree());
		const before = [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		];
		store.saveMessages(chat.id, before);

		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async () => {
					throw new Error("provider down");
				},
			}),
			chat.id,
		);

		assert.equal(result, "failed");
		assert.equal(newestLessonRecord(store.getChat(chat.id)!.messages), null);
		assert.equal(store.getChat(chat.id)!.messages.length, before.length);
	});

	// plan 001 part 5 rule 8: re-read record and insert marker at old end index (#518 seam)
	it("inserts marker at the old end index when messages arrive while summarizing", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("concurrent append");
		store.saveTree(chat.id, threeUnitTree());
		const u0 = newUserMessage("start");
		const a1 = assistantTeachCall("a1", "c1", "n1");
		const a2 = assistantTeachCall("a2", "c2", "n2");
		store.saveMessages(chat.id, [u0, a1, a2]);

		const lateMsg = newUserMessage("arrived mid-summary");
		const result = await runUnitCut(
			makeDeps(store, {
				summarize: async () => {
					const cur = store.getChat(chat.id)!;
					store.saveMessages(chat.id, [...cur.messages, lateMsg]);
					return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(result, "done");
		const after = store.getChat(chat.id)!.messages;
		assert.equal(after.length, 5);
		assert.equal((after[3] as LhMarkerMessage).customType, "lesson-record");
		assert.equal(after[4]!.id, lateMsg.id);
	});

	// plan 001 part 5 rule 10 & Tests: the running event carries unit
	it("emits compaction-changed running:true with unit: cur + 1 before and running:false after on success and failure", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("events");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		const changes: Array<{ running: boolean; unit?: number }> = [];
		const unsubscribe = subscribe((e) => {
			if (e.type === "compaction-changed" && e.chatId === chat.id) {
				changes.push({ running: e.running, unit: e.unit });
			}
		});
		try {
			await runUnitCut(
				makeDeps(store, {
					summarize: async () => ({ summary: "bad", usage: ZERO_USAGE }),
				}),
				chat.id,
			);
			await runUnitCut(
				makeDeps(store, {
					summarize: async () => ({ summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE }),
				}),
				chat.id,
			);
		} finally {
			unsubscribe();
		}

		assert.deepEqual(changes, [
			{ running: true, unit: 2 },
			{ running: false, unit: undefined },
			{ running: true, unit: 2 },
			{ running: false, unit: undefined },
		]);
	});
});

describe("maintain (ensureCompacted & kickCompaction)", () => {
	// plan 001 part 5 Files & maintain: ensureCompacted and kickCompaction trigger when unitCutDue || overThreshold
	it("ensureCompacted and kickCompaction run unit cut when unitCutDue is true even under thresholdTokens", async () => {
		const store = createMemoryChatStore();

		const gateChat = store.createChat("gate due");
		store.saveTree(gateChat.id, threeUnitTree());
		store.saveMessages(gateChat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);
		let gateCalls = 0;
		await ensureCompacted(
			makeDeps(store, {
				thresholdTokens: 500_000,
				summarize: async () => {
					gateCalls++;
					return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
				},
			}),
			gateChat.id,
		);
		assert.equal(gateCalls, 1);
		assert.ok(newestLessonRecord(store.getChat(gateChat.id)!.messages));

		const kickChat = store.createChat("kick due");
		store.saveTree(kickChat.id, threeUnitTree());
		store.saveMessages(kickChat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);
		let kickCalls = 0;
		kickCompaction(
			() =>
				makeDeps(store, {
					thresholdTokens: 500_000,
					summarize: async () => {
						kickCalls++;
						return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
					},
				}),
			kickChat.id,
		);
		await awaitCompaction(kickChat.id);
		assert.equal(kickCalls, 1);
		assert.ok(newestLessonRecord(store.getChat(kickChat.id)!.messages));
	});

	// plan 001 part 5 maintain: a failed unit cut falls back to compaction inside the old unit when over threshold
	it("ensureCompacted falls back to compaction inside the old unit when runUnitCut fails and projection is over threshold", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("fallback compaction");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage(`big unit 1 ${"x".repeat(4_000)}`),
			assistantTeachCall("a1", "c1", "n1"),
			toolResultFor("r1", "c1"),
			assistantTeachCall("a2", "c2", "n2"),
			// over KEEP_RECENT_TOKENS on its own, so the compaction has a cut point
			newUserMessage(`recent ${"r".repeat(100_000)}`),
		]);

		const prompts: string[] = [];
		await ensureCompacted(
			makeDeps(store, {
				thresholdTokens: 20_000,
				summarize: async (prompt) => {
					prompts.push(prompt);
					// First two calls are unit cut (invalid JSON -> fails); third is compaction summary
					if (prompts.length <= 2) return { summary: "not-json", usage: ZERO_USAGE };
					return { summary: "Compacted unit 1 summary.", usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(prompts.length, 3);
		assert.equal(newestLessonRecord(store.getChat(chat.id)!.messages), null);
		const compacted = store
			.getChat(chat.id)!
			.messages.some((m) => m.role === "custom" && m.customType === "compaction");
		assert.equal(compacted, true);
	});

	// plan 001 part 5 maintain: after a successful unit cut, the compaction loop runs only if the projection is still over threshold
	it("ensureCompacted skips the compaction loop when the unit cut brings the projection under threshold", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("cut then under");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage(`big unit 1 ${"x".repeat(4_000)}`),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		let calls = 0;
		await ensureCompacted(
			makeDeps(store, {
				// the unit-cut prompt must fit the threshold (ceil(chars / 4))
				thresholdTokens: 5_000,
				summarize: async () => {
					calls++;
					return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.equal(calls, 1);
		const msgs = store.getChat(chat.id)!.messages;
		assert.ok(newestLessonRecord(msgs));
		assert.equal(msgs.some((m) => m.role === "custom" && m.customType === "compaction"), false);
	});

	// plan 001 part 5 maintain: after a successful unit cut, compaction still runs if the projection is over threshold
	it("ensureCompacted runs the compaction loop after a successful unit cut when the projection is still over threshold", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("cut then over");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2", `unit 2 ${"y".repeat(4_000)}`),
			newUserMessage(`more unit 2 ${"z".repeat(4_000)}`),
			// over KEEP_RECENT_TOKENS on its own, so the compaction has a cut point
			newUserMessage(`recent ${"r".repeat(100_000)}`),
		]);

		let calls = 0;
		await ensureCompacted(
			makeDeps(store, {
				thresholdTokens: 20_000,
				summarize: async () => {
					calls++;
					if (calls === 1) return { summary: validJudgmentJson(["n1"]), usage: ZERO_USAGE };
					return { summary: "Compacted summary.", usage: ZERO_USAGE };
				},
			}),
			chat.id,
		);

		assert.ok(calls >= 2);
		const msgs = store.getChat(chat.id)!.messages;
		assert.ok(newestLessonRecord(msgs));
		assert.equal(msgs.some((m) => m.role === "custom" && m.customType === "compaction"), true);
	});

	// plan 001 part 5 maintain: under NODE_ENV=test without an injected summarizer, ensureCompacted stays a no-op
	it("ensureCompacted stays a no-op under NODE_ENV=test without an injected summarizer even when unitCutDue is true", async () => {
		const store = createMemoryChatStore();
		const chat = store.createChat("test noop");
		store.saveTree(chat.id, threeUnitTree());
		store.saveMessages(chat.id, [
			newUserMessage("start"),
			assistantTeachCall("a1", "c1", "n1"),
			assistantTeachCall("a2", "c2", "n2"),
		]);

		await ensureCompacted(makeDeps(store), chat.id);
		assert.equal(newestLessonRecord(store.getChat(chat.id)!.messages), null);
	});
});
