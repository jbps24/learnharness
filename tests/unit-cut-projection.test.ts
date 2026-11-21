import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	COMPACTED_HISTORY_HEADER,
	newCompactionMarker,
	sideChatLessonDocument,
	toLlmMessages,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/index.ts";

const userMsg = (id: string, text: string, timestamp = 1): LhMessage => ({
	id,
	role: "user",
	content: text,
	timestamp,
});

const lessonRecordMarker = (
	id: string,
	firstKeptMessageId: string,
	content = "[LESSON RECORD] summary of earlier units",
	timestamp = 10,
): LhMessage => {
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
		content,
		display: true,
		details,
		timestamp,
	};
};

const compactionMarker = (
	id: string,
	firstKeptMessageId: string,
	summary = "COMPACTION SUMMARY",
	timestamp = 20,
): LhMessage => ({
	...(newCompactionMarker(summary, {
		firstKeptMessageId,
		tokensBefore: 1000,
		at: "2026-11-20T00:00:00.000Z",
	}) as LhMarkerMessage),
	id,
	timestamp,
});

const textOf = (m: { content: unknown }): string =>
	typeof m.content === "string"
		? m.content
		: ((m.content as Array<{ text?: string }>)[0]?.text ?? "");

describe("toLlmMessages with lesson-record and compaction cuts", () => {
	// plan 001 part 4, rule 1: no lesson-record marker preserves compaction-only projection
	it("preserves compaction-only projection when no lesson-record marker exists", () => {
		const msgs = [userMsg("u1", "old"), userMsg("u2", "kept"), compactionMarker("c1", "u2", "COMPACT_ONLY")];
		const out = toLlmMessages(msgs as never);
		assert.equal(out.length, 2);
		assert.equal(textOf(out[0]!), `${COMPACTED_HISTORY_HEADER}\n\nCOMPACT_ONLY`);
		assert.equal(textOf(out[1]!), "kept");
	});

	// plan 001 part 4, rule 1: R and C absent -> heads [R.content], start r
	it("projects [R.content] and starts at r when only a lesson-record marker exists", () => {
		const msgs = [
			userMsg("u1", "unit 1"),
			userMsg("u2", "unit 2 start"),
			userMsg("u3", "unit 2 next"),
			lessonRecordMarker("r1", "u2", "RECORD_HEAD"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["RECORD_HEAD", "unit 2 start", "unit 2 next"],
		);
	});

	// plan 001 part 4, rule 1: R and c < r -> heads [R.content], start r (older compaction ignored)
	it("ignores an older compaction before the lesson record (c < r)", () => {
		const msgs = [
			userMsg("u1", "unit 1 early"),
			userMsg("u2", "unit 1 late"),
			compactionMarker("c1", "u2", "OLD_COMPACT"),
			userMsg("u3", "unit 2 start"),
			lessonRecordMarker("r1", "u3", "RECORD_HEAD"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["RECORD_HEAD", "unit 2 start"],
		);
		assert.equal(JSON.stringify(out).includes("OLD_COMPACT"), false);
	});

	// plan 001 part 4, rule 1: R and c missing -> heads [R.content], start r
	it("ignores a compaction whose kept id is missing when a lesson record exists", () => {
		const msgs = [
			userMsg("u1", "unit 1"),
			userMsg("u2", "unit 2 start"),
			lessonRecordMarker("r1", "u2", "RECORD_HEAD"),
			compactionMarker("c1", "missing-id", "CORRUPT_COMPACT"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["RECORD_HEAD", "unit 2 start"],
		);
		assert.equal(JSON.stringify(out).includes("CORRUPT_COMPACT"), false);
	});

	// plan 001 part 4, rule 1: R and c >= r (c > r) -> heads [R.content, C.content] in that order, start c
	it("projects [R.content, C.content] in order and starts at c for an in-unit compaction (c > r)", () => {
		const msgs = [
			userMsg("u1", "unit 1"),
			userMsg("u2", "unit 2 compacted"),
			lessonRecordMarker("r1", "u2", "RECORD_HEAD"),
			userMsg("u3", "unit 2 middle"),
			userMsg("u4", "unit 2 kept"),
			compactionMarker("c1", "u4", "IN_UNIT_COMPACT"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["RECORD_HEAD", `${COMPACTED_HISTORY_HEADER}\n\nIN_UNIT_COMPACT`, "unit 2 kept"],
		);
	});

	// plan 001 part 4, rule 1: R and c >= r (tie c === r) -> heads [R.content, C.content] in that order, start c
	it("projects [R.content, C.content] in order when compaction and record share the same kept index (c === r)", () => {
		const msgs = [
			userMsg("u1", "unit 1"),
			userMsg("u2", "unit 2 kept"),
			lessonRecordMarker("r1", "u2", "RECORD_HEAD"),
			userMsg("u3", "unit 2 tail"),
			compactionMarker("c1", "u2", "SAME_CUT_COMPACT"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["RECORD_HEAD", `${COMPACTED_HISTORY_HEADER}\n\nSAME_CUT_COMPACT`, "unit 2 kept", "unit 2 tail"],
		);
	});

	// plan 001 part 4, rule 1: every compaction and lesson-record marker in the retained range is skipped
	it("skips older lesson-record and compaction markers inside the retained range", () => {
		const msgs = [
			userMsg("u1", "unit 1"),
			userMsg("u1b", "unit 1b"),
			userMsg("u2", "unit 2"),
			lessonRecordMarker("r_old", "u1b", "OLD_RECORD"),
			compactionMarker("c_old", "u1b", "OLD_COMPACT"),
			userMsg("u3", "unit 3"),
			lessonRecordMarker("r_new", "u2", "NEW_RECORD"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			["NEW_RECORD", "unit 2", "unit 3"],
		);
	});

	// plan 001 part 4, rule 1: a record whose kept id is missing is ignored (falls through to compaction-only rule)
	it("ignores a lesson record with a missing kept id and falls through to the compaction-only rule", () => {
		const msgs = [
			userMsg("u1", "dropped"),
			userMsg("u2", "kept"),
			compactionMarker("c1", "u2", "FALLBACK_COMPACT"),
			userMsg("u3", "after"),
			lessonRecordMarker("r1", "missing-id", "BROKEN_RECORD"),
		];
		const out = toLlmMessages(msgs as never);
		assert.deepEqual(
			out.map((m) => textOf(m)),
			[`${COMPACTED_HISTORY_HEADER}\n\nFALLBACK_COMPACT`, "kept", "after"],
		);
	});

	// plan 001 part 4, rule 1: leading system message stays ahead of [R.content, C.content]
	it("keeps leading system chrome ahead of [R.content, C.content]", () => {
		const chrome = { id: "sys", role: "system", content: "SYSTEM", timestamp: 0 };
		const msgs = [
			chrome,
			userMsg("u1", "unit 1"),
			userMsg("u2", "unit 2"),
			lessonRecordMarker("r1", "u2", "RECORD_HEAD"),
			userMsg("u3", "unit 3"),
			compactionMarker("c1", "u3", "COMPACT_HEAD"),
		];
		const out = toLlmMessages(msgs as never);
		assert.equal(out[0]!.role, "system");
		assert.deepEqual(
			out.slice(1).map((m) => textOf(m)),
			["RECORD_HEAD", `${COMPACTED_HISTORY_HEADER}\n\nCOMPACT_HEAD`, "unit 3"],
		);
	});
});

describe("sideChatLessonDocument with lesson-record and compaction cuts", () => {
	// plan 001 part 4, rule 5: side lesson document after a record starts at r, omits earlier history, and never includes record content
	it("starts at r after a lesson record and never includes the record content", () => {
		const msgs = [
			userMsg("u1", "before unit cut"),
			userMsg("u2", "after unit cut"),
			lessonRecordMarker("r1", "u2", "PRIVATE_RECORD_CONTENT"),
		];
		const doc = sideChatLessonDocument(msgs);
		assert.ok(doc.includes("Earlier history is omitted"));
		assert.ok(doc.includes("after unit cut"));
		assert.equal(doc.includes("before unit cut"), false);
		assert.equal(doc.includes("PRIVATE_RECORD_CONTENT"), false);
	});

	// plan 001 part 4, rule 5: starts at the later kept index of R and C (c > r)
	it("starts at c when an in-unit compaction follows the lesson record (c > r)", () => {
		const msgs = [
			userMsg("u1", "unit 1 text"),
			userMsg("u2", "unit 2 early"),
			lessonRecordMarker("r1", "u2", "RECORD_CONTENT"),
			userMsg("u3", "unit 2 late"),
			compactionMarker("c1", "u3", "COMPACTION_SUMMARY"),
		];
		const doc = sideChatLessonDocument(msgs);
		assert.ok(doc.includes("Earlier history is omitted"));
		assert.ok(doc.includes("unit 2 late"));
		assert.equal(doc.includes("unit 1 text"), false);
		assert.equal(doc.includes("unit 2 early"), false);
		assert.equal(doc.includes("RECORD_CONTENT"), false);
		assert.equal(doc.includes("COMPACTION_SUMMARY"), false);
	});

	// plan 001 part 4, rule 5: starts at the later kept index of R and C (c < r)
	it("starts at r when an older compaction precedes the lesson record (c < r)", () => {
		const msgs = [
			userMsg("u1", "very early"),
			userMsg("u2", "mid unit 1"),
			compactionMarker("c1", "u2", "OLD_COMPACTION"),
			userMsg("u3", "unit 2 current"),
			lessonRecordMarker("r1", "u3", "RECORD_CONTENT"),
		];
		const doc = sideChatLessonDocument(msgs);
		assert.ok(doc.includes("Earlier history is omitted"));
		assert.ok(doc.includes("unit 2 current"));
		assert.equal(doc.includes("very early"), false);
		assert.equal(doc.includes("mid unit 1"), false);
		assert.equal(doc.includes("OLD_COMPACTION"), false);
		assert.equal(doc.includes("RECORD_CONTENT"), false);
	});
});
