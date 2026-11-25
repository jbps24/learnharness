import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-budget-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const {
	ensureCompacted,
	antigravityRequestTrigger,
	antigravityKeptTail,
	antigravitySummaryFit,
} = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
import {
	AGY_COMPACT_AT_BYTES,
	AGY_MIN_SUMMARY_BYTES,
	AGY_MIN_TURN_ROOM_BYTES,
	AGY_TOOL_SCHEMA_RESERVE_BYTES,
	agyKeepRecentBytes,
	antigravityRequestBytes,
	projectedAntigravityRequestBytes,
} from "../src/agent/antigravity/request.ts";
import { ANTIGRAVITY_PROVIDER } from "../src/core/contracts/antigravity.ts";
import {
	activeCompactionOf,
	newUserMessage,
	toLlmMessages,
	type CourseMaterial,
	type LhMarkerMessage,
	type LhMessage,
	type PlanTree,
} from "../src/core/index.ts";
import { newMessageId } from "../src/core/native-messages.ts";
import { agyFixedBytes } from "../src/agent/antigravity/request.ts";
import { failedResponseAtEnd, retryableReply } from "../src/core/input-events.ts";
import { condenseLessonRecordPlan } from "../src/core/lesson-record.ts";

const NOTICE =
	"The conversation is close to this model's size limit, and compacting now would not free enough room. You can keep going; if the limit is reached, switch to a model with a larger context.";

function skippedNotices(messages: readonly LhMessage[]): LhMarkerMessage[] {
	return messages.filter(
		(m): m is LhMarkerMessage => m.role === "custom" && m.customType === "compaction-skipped",
	);
}

function agyDeps(instructions: string, summary: string, onSummarize: () => void): CompactionDeps {
	return {
		chatStore,
		engine: { model: { provider: ANTIGRAVITY_PROVIDER, id: "gemini-4-hydrogen", contextWindow: 128_000 } } as never,
		modelId: `${ANTIGRAVITY_PROVIDER}:gemini-4-hydrogen`,
		kind: "teach",
		thresholdTokens: 150_000,
		systemPromptTokens: Math.ceil(instructions.length / 4),
		requestOverLimit: antigravityRequestTrigger(ANTIGRAVITY_PROVIDER, instructions),
		keptTail: antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions),
		summaryRequestFits: antigravitySummaryFit(ANTIGRAVITY_PROVIDER),
		summarize: async () => {
			onSummarize();
			return {
				summary,
				usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
		},
	};
}

/** Append turns until the projected request is over the compaction trigger. */
function fillOverTrigger(messages: LhMessage[], instructions: string, label: string): void {
	let turn = 0;
	while (projectedAntigravityRequestBytes(toLlmMessages(messages as never), instructions) <= AGY_COMPACT_AT_BYTES) {
		turn++;
		messages.push(...makeTurn(`${label}${turn}`, 3_500));
	}
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function assistantText(text: string): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

function makeTurn(label: string, totalBytes: number): LhMessage[] {
	const half = Math.floor(totalBytes / 2);
	return [
		newUserMessage(`${label} u ${"a".repeat(half)}`),
		assistantText(`${label} a ${"b".repeat(half)}`),
	];
}

function makeLessonRecord(firstKeptMessageId: string, bodyBytes: number): LhMarkerMessage {
	const content = [
		"[LESSON RECORD] Earlier units.",
		"## Plan",
		"Unit 1 · Foundations (finished)",
		"- [visited] Intro (n1)",
		"Unit 2 · Core (current)",
		"- [current] Deep Dive (n2)",
		"## The learner, per node",
		`### Intro (n1)\nLearned: ${"k".repeat(bodyBytes)}`,
	].join("\n");
	return {
		id: newMessageId(),
		role: "custom",
		customType: "lesson-record",
		content,
		display: false,
		details: {
			firstKeptMessageId,
			finishedUnitIds: [],
			currentUnitId: "u1",
			judgment: { learnerWide: "", commitments: "", nodes: {} },
			at: "2026-11-25T00:00:00.000Z",
		},
		timestamp: Date.now(),
	};
}

describe("agy compaction budget (plan 022 part 3)", () => {
	// plan 022 part 3: AGY_MIN_TURN_ROOM_BYTES is 16 KB
	it("defines AGY_MIN_TURN_ROOM_BYTES as 16 KB", () => {
		assert.equal(AGY_MIN_TURN_ROOM_BYTES, 16 * 1024);
	});

	// plan 022 part 3: agyKeepRecentBytes counts instructions, 24 KB schema reserve, max(prior, 16 KB), and extraFixedBytes
	it("agyKeepRecentBytes subtracts extraFixedBytes and halves remaining room under AGY_COMPACT_AT_BYTES", () => {
		const instructions = "x".repeat(46 * 1024);
		const extraFixed = 32 * 1024 + 15 * 1024;
		const baseFixed =
			antigravityRequestBytes([], instructions) +
			AGY_TOOL_SCHEMA_RESERVE_BYTES +
			AGY_MIN_SUMMARY_BYTES +
			extraFixed;
		const expected = Math.max(0, Math.floor((AGY_COMPACT_AT_BYTES - baseFixed) / 2));
		assert.equal(agyKeepRecentBytes(instructions, 0, extraFixed), expected);

		// plan 022 part 3: expected summary is max(prior, 16 KB)
		const largerPrior = 20 * 1024;
		const priorFixed =
			antigravityRequestBytes([], instructions) +
			AGY_TOOL_SCHEMA_RESERVE_BYTES +
			largerPrior +
			extraFixed;
		assert.equal(
			agyKeepRecentBytes(instructions, largerPrior, extraFixed),
			Math.max(0, Math.floor((AGY_COMPACT_AT_BYTES - priorFixed) / 2)),
		);

		// plan 022 part 3: clamps to 0 when fixed >= AGY_COMPACT_AT_BYTES
		assert.equal(agyKeepRecentBytes(instructions, 0, AGY_COMPACT_AT_BYTES), 0);
	});

	// plan 022 part 3: replaying measured composition (46 KB instructions, 32 KB record, 15 KB notes, 3–4 KB turns)
	it("leaves >= 16 KB under trigger after compaction and does not compact again for the next 3 turns of 4 KB", async () => {
		const instructions = "i".repeat(46 * 1024);
		const chat = chatStore.createChat("agy-budget-replay");
		const tree: PlanTree = {
			version: 1,
			nodes: [
				{ id: "n1", title: "Intro", summary: "s1" },
				{ id: "n2", title: "Deep Dive", summary: "s2" },
			],
			edges: [{ from: "n1", to: "n2" }],
			units: [
				{ id: "u1", title: "Foundations", nodeIds: ["n1", "n2"] },
			],
		};
		chatStore.saveTree(chat.id, tree);
		const material: CourseMaterial = {
			files: [
				{
					path: "/course/notes.pdf",
					addedAt: "2026-11-25T00:00:00.000Z",
					via: "learner",
					binding: true,
					status: "assigned",
					category: "material",
				},
			],
			methods: [
				{
					nodeId: "n1",
					path: "/course/notes.pdf",
					method: "m".repeat(15 * 1024),
				},
			],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);

		const firstKept = newUserMessage("start unit 2");
		const recordMarker = makeLessonRecord(firstKept.id, 20 * 1024);
		const messages: LhMessage[] = [recordMarker, firstKept];
		fillOverTrigger(messages, instructions, "t");
		chatStore.saveMessages(chat.id, messages);

		// a realistic summary (8 KB), not a stub that hides a budget gap
		let summarizeCalls = 0;
		const deps = agyDeps(instructions, "s".repeat(8 * 1024), () => summarizeCalls++);

		// plan 022 part 3: the kept-tail budget counts the record and the notes the compaction appends
		const budget = antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions)!(messages as never)!.budget;
		assert.ok(
			budget <=
				agyKeepRecentBytes(instructions, 0, Buffer.byteLength(recordMarker.content as string) + 15 * 1024),
			`kept-tail budget ${budget} ignores the 15 KB notes or the record`,
		);

		await ensureCompacted(deps, chat.id);
		assert.equal(summarizeCalls, 1);

		const afterCompact = chatStore.getChat(chat.id)!.messages;
		assert.ok(activeCompactionOf(afterCompact) !== null);
		// plan 022 decision 5: the course notes are kept through the compaction
		assert.ok(
			afterCompact.some((m) => m.role === "custom" && m.customType === "course-method"),
			"the course-method note rides along after the compaction",
		);
		const postBytes = projectedAntigravityRequestBytes(toLlmMessages(afterCompact as never), instructions);
		assert.ok(
			AGY_COMPACT_AT_BYTES - postBytes >= AGY_MIN_TURN_ROOM_BYTES,
			`expected >= ${AGY_MIN_TURN_ROOM_BYTES} bytes under trigger, got ${AGY_COMPACT_AT_BYTES - postBytes}`,
		);

		for (let i = 1; i <= 3; i++) {
			const current = chatStore.getChat(chat.id)!.messages;
			chatStore.saveMessages(chat.id, [...current, ...makeTurn(`next${i}`, 4 * 1024)]);
			await ensureCompacted(deps, chat.id);
		}
		assert.equal(summarizeCalls, 1, "next 3 turns of 4 KB must not compact again");
	});

	// plan 022 part 3: when fixed >= trigger - 16 KB, no compaction runs, one notice marker is written, and notice is not in model context
	it("skips compaction and writes one compaction-skipped notice per span when fixed >= trigger - 16 KB", async () => {
		const instructions = "i".repeat(46 * 1024);
		const chat = chatStore.createChat("agy-no-gain");
		const firstKept = newUserMessage("start unit 2");
		// 46 KB instructions + 24 KB schema + 16 KB summary + 60 KB record leaves < 16 KB under 160_000
		const hugeRecord = makeLessonRecord(firstKept.id, 60 * 1024);
		const messages: LhMessage[] = [hugeRecord, firstKept];
		fillOverTrigger(messages, instructions, "t");
		chatStore.saveMessages(chat.id, messages);

		let summarizeCalls = 0;
		const deps = agyDeps(instructions, "Should not run.", () => summarizeCalls++);

		await ensureCompacted(deps, chat.id);
		assert.equal(summarizeCalls, 0);

		const afterFirst = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeCompactionOf(afterFirst), null);
		const noticesAfterFirst = skippedNotices(afterFirst);
		assert.equal(noticesAfterFirst.length, 1);
		// plan 022 part 3: the confirmed notice text, verbatim
		assert.ok(String(noticesAfterFirst[0]!.content).includes(NOTICE));

		// plan 022 part 3: written once per compaction span
		chatStore.saveMessages(chat.id, [...afterFirst, ...makeTurn("t2", 4 * 1024)]);
		await ensureCompacted(deps, chat.id);
		const afterSecond = chatStore.getChat(chat.id)!.messages;
		assert.equal(summarizeCalls, 0);
		assert.equal(skippedNotices(afterSecond).length, 1);

		// plan 022 part 3: the notice is not in the model context
		const withoutNotice = afterSecond.filter((m) => m.role !== "custom" || m.customType !== "compaction-skipped");
		assert.deepEqual(
			toLlmMessages(afterSecond as never),
			toLlmMessages(withoutNotice as never),
		);
	});

	// plan 022 part 3: the notice is written once per compaction span — a new span gets its own
	it("writes a second notice when a new span (a later lesson-record cut) hits no-gain again", async () => {
		const instructions = "i".repeat(46 * 1024);
		const chat = chatStore.createChat("agy-no-gain-spans");
		const kept1 = newUserMessage("start span 1");
		const messages: LhMessage[] = [makeLessonRecord(kept1.id, 60 * 1024), kept1];
		fillOverTrigger(messages, instructions, "a");
		chatStore.saveMessages(chat.id, messages);

		let summarizeCalls = 0;
		const deps = agyDeps(instructions, "Should not run.", () => summarizeCalls++);
		await ensureCompacted(deps, chat.id);
		assert.equal(skippedNotices(chatStore.getChat(chat.id)!.messages).length, 1);

		const kept2 = newUserMessage("start span 2");
		const next: LhMessage[] = [...chatStore.getChat(chat.id)!.messages, makeLessonRecord(kept2.id, 60 * 1024), kept2];
		fillOverTrigger(next, instructions, "b");
		chatStore.saveMessages(chat.id, next);
		await ensureCompacted(deps, chat.id);

		assert.equal(summarizeCalls, 0);
		assert.equal(skippedNotices(chatStore.getChat(chat.id)!.messages).length, 2);
	});

	// plan 022 part 3: the kept-tail budget counts the condensed lesson record (part 2), not the stored one
	it("budgets the condensed lesson record, not its stored size", () => {
		const instructions = "i".repeat(46 * 1024);
		const questions = Array.from(
			{ length: 400 },
			(_, i) => `    · quiz — "${"q".repeat(200)}${i}" — ${i % 3 === 0 ? "right" : "wrong (slip)"}`,
		);
		const stored = [
			"[LESSON RECORD] Earlier units.",
			"## Plan",
			"Unit 1 · Foundations (current)",
			"- [current] Intro (n1)",
			...questions,
			"## The learner, per node",
			"### Intro (n1)\nLearned: ok",
		].join("\n");
		const condensedBytes = Buffer.byteLength(condenseLessonRecordPlan(stored));
		const storedBytes = Buffer.byteLength(stored);
		// the stored record alone would eat the whole budget; the condensed one leaves room
		assert.ok(storedBytes > AGY_COMPACT_AT_BYTES - 46 * 1024 - AGY_TOOL_SCHEMA_RESERVE_BYTES - AGY_MIN_SUMMARY_BYTES);
		assert.ok(condensedBytes < 8 * 1024);

		const kept = newUserMessage("go on");
		const record = { ...makeLessonRecord(kept.id, 0), content: stored };
		const messages: LhMessage[] = [record, kept, ...makeTurn("t", 4 * 1024)];
		const budget = antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions)!(messages as never)!.budget;
		assert.ok(budget > 0, "the condensed record leaves a positive tail budget");
		assert.ok(budget <= agyKeepRecentBytes(instructions, 0, condensedBytes));
	});
});

describe("agy compaction budget: boundaries and note accounting", () => {
	// plan 022 part 3: exactly 16 KB of room is enough; one byte less is no gain
	it("treats exactly AGY_MIN_TURN_ROOM_BYTES of room as gain and one byte less as no gain", () => {
		const target = AGY_COMPACT_AT_BYTES - AGY_MIN_TURN_ROOM_BYTES;
		const length = target - agyFixedBytes("", 0);
		const messages: LhMessage[] = makeTurn("t", 1024);
		const exact = "i".repeat(length);
		assert.equal(agyFixedBytes(exact, 0), target);
		assert.equal(antigravityKeptTail(ANTIGRAVITY_PROVIDER, exact)!(messages as never)!.noGain, false);
		assert.equal(antigravityKeptTail(ANTIGRAVITY_PROVIDER, exact + "i")!(messages as never)!.noGain, true);
	});

	function planChat(label: string, kind: "teach" | "practice") {
		const chat = chatStore.createChat(label);
		const tree: PlanTree = {
			version: 1,
			nodes: [{ id: "n1", title: "Intro", summary: "s1" }],
			edges: [],
			units: [{ id: "u1", title: "Foundations", nodeIds: ["n1"] }],
		};
		chatStore.saveTree(chat.id, tree);
		chatStore.setCourseMaterial(chat.id, {
			files: [{ path: "/course/notes.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" }],
			methods: [{ nodeId: "n1", path: "/course/notes.pdf", method: "m".repeat(15 * 1024) }],
			conflicts: [],
		});
		return { ...chatStore.getChat(chat.id)!, kind } as never;
	}

	// plan 022 decision 5: a practice chat has no course notes, so none are reserved
	it("reserves no course-note bytes for a practice chat", () => {
		const instructions = "i".repeat(46 * 1024);
		const messages: LhMessage[] = makeTurn("t", 1024);
		const keptTail = antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions)!;
		assert.equal(keptTail(messages as never, planChat("agy-practice", "practice"))!.budget, agyKeepRecentBytes(instructions, 0, 0));
		assert.ok(keptTail(messages as never, planChat("agy-teach", "teach"))!.budget < agyKeepRecentBytes(instructions, 0, 0));
	});

	// plan 022 decision 5: notes already in the chat are dropped by the cut, so they still count as appended
	it("counts the course notes already in the chat the same as when they are absent", () => {
		const instructions = "i".repeat(46 * 1024);
		const record = planChat("agy-notes", "teach");
		const note = {
			id: newMessageId(), role: "custom", customType: "course-method", content: "m".repeat(15 * 1024),
			display: false, timestamp: Date.now(),
		} as unknown as LhMessage;
		const bare: LhMessage[] = makeTurn("t", 1024);
		const keptTail = antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions)!;
		assert.equal(keptTail([note, ...bare] as never, record)!.budget, keptTail(bare as never, record)!.budget);
	});

	// a compaction-skipped marker does not end the scan for a failed response
	it("still finds a failed response before a compaction-skipped marker", () => {
		const failed = { ...assistantText("boom"), stopReason: "error" } as unknown as LhMessage;
		const marker = {
			id: newMessageId(), role: "custom", customType: "compaction-skipped", content: NOTICE, display: true, timestamp: Date.now(),
		} as unknown as LhMessage;
		assert.equal(failedResponseAtEnd([newUserMessage("hi"), failed, marker]), failed);
	});

	// a compaction-skipped marker after a good reply keeps Retry available
	it("keeps the latest reply retryable when a compaction-skipped marker follows it", () => {
		const reply = { ...assistantText("ok"), stopReason: "stop" } as unknown as LhMessage;
		const marker = {
			id: newMessageId(), role: "custom", customType: "compaction-skipped", content: NOTICE, display: true, timestamp: Date.now(),
		} as unknown as LhMessage;
		assert.deepEqual(retryableReply([newUserMessage("hi"), reply, marker]), [reply.id]);
	});
});

describe("agy compaction budget: real due-note filtering", () => {
	// plan 022 decision 5: real course notes (with valid digests/details) in history are dropped by the cut, so they still count as due
	it("counts real course notes already in the chat the same as when they are absent", async () => {
		const { courseNotesFor } = await import("../src/core/course-notes.ts");
		const instructions = "i".repeat(46 * 1024);
		const chat = chatStore.createChat("agy-real-notes");
		const tree: PlanTree = {
			version: 1,
			nodes: [{ id: "n1", title: "Intro", summary: "s1" }],
			edges: [],
			units: [{ id: "u1", title: "Foundations", nodeIds: ["n1"] }],
		};
		chatStore.saveTree(chat.id, tree);
		const material: CourseMaterial = {
			files: [{ path: "/course/notes.pdf", addedAt: "2026-11-25T00:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" }],
			methods: [{ nodeId: "n1", path: "/course/notes.pdf", method: "m".repeat(15 * 1024) }],
			conflicts: [],
		};
		chatStore.setCourseMaterial(chat.id, material);
		const record = chatStore.getChat(chat.id)!;
		const bare: LhMessage[] = [newUserMessage("hello")];
		const realNotes = courseNotesFor([], tree, material);
		assert.ok(realNotes.length > 0);
		const keptTail = antigravityKeptTail(ANTIGRAVITY_PROVIDER, instructions)!;
		assert.equal(keptTail([...realNotes, ...bare] as never, record)!.budget, keptTail(bare as never, record)!.budget);
	});
});
