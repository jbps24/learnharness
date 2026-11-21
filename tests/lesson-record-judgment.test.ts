import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CHECK_STEM_CLIP,
	EXPLAIN_ANSWER_CLIP,
	LESSON_RECORD_CAPS,
	LESSON_RECORD_HEADER,
	type LessonJudgment,
} from "../src/core/contracts/chat.ts";
import {
	buildLessonRecordPrompt,
	mergeJudgment,
	parseLessonJudgment,
} from "../src/core/lesson-record.ts";

describe("lesson-record constants", () => {
	// plan 001 part 3: contract constants match the confirmed values
	it("matches the plan constants and header", () => {
		assert.deepEqual(LESSON_RECORD_CAPS, {
			learned: 400,
			errorsCorrected: 300,
			openPoints: 300,
			learnerWide: 1500,
			commitments: 600,
		});
		assert.equal(CHECK_STEM_CLIP, 120);
		assert.equal(EXPLAIN_ANSWER_CLIP, 160);
		assert.equal(
			LESSON_RECORD_HEADER,
			"[LESSON RECORD] The lesson before this point was taught in earlier units; this record replaces that transcript. Its progress facts are computed by the app and are authoritative. Everything after this message is the verbatim transcript of the current unit.",
		);
	});
});

describe("buildLessonRecordPrompt", () => {
	// plan 001 part 3: buildLessonRecordPrompt includes confirmed prompt wording, facts, previous judgment, and TRANSCRIPT: spanText
	it("builds the summarizer prompt with facts, previous judgment, and transcript", () => {
		const previous: LessonJudgment = {
			learnerWide: "Prefers concrete examples first.",
			commitments: "Revisit Bode plot after unit 3",
			nodes: {
				n1: {
					learned: "Knows basic limits.",
					errorsCorrected: "Fixed 0/0 assumption.",
					openPoints: "",
				},
			},
		};
		const prompt = buildLessonRecordPrompt({
			taughtIds: ["n1", "n2"],
			facts: "## Plan\nUnit 1 · Intro (current)",
			previous,
			spanText: "[LEARNER] Hello",
		});

		assert.ok(prompt.includes("You are writing the judgment part of a lesson record:"));
		assert.ok(prompt.includes("which were taught in this stretch: n1, n2"));
		assert.ok(prompt.includes("## Plan\nUnit 1 · Intro (current)"));
		assert.ok(prompt.includes("Prefers concrete examples first."));
		assert.ok(prompt.includes("Revisit Bode plot after unit 3"));
		assert.ok(prompt.includes("Knows basic limits."));
		assert.ok(prompt.includes("TRANSCRIPT:"));
		assert.ok(prompt.includes("[LEARNER] Hello"));
	});
});

describe("buildLessonRecordPrompt previous entries", () => {
	// plan 001 part 3: the prompt carries previous entries only for the listed ids
	it("includes previous entries only for the listed taught ids", () => {
		const prompt = buildLessonRecordPrompt({
			taughtIds: ["n1"],
			facts: "facts",
			previous: {
				learnerWide: "wide",
				commitments: "",
				nodes: {
					n1: { learned: "LISTED-ENTRY", errorsCorrected: "", openPoints: "" },
					n9: { learned: "UNLISTED-ENTRY", errorsCorrected: "", openPoints: "" },
				},
			},
			spanText: "span",
		});
		assert.ok(prompt.includes("LISTED-ENTRY"));
		assert.equal(prompt.includes("UNLISTED-ENTRY"), false);
	});
});

describe("parseLessonJudgment", () => {
	const validPayload = {
		learnerWide: "Learns well from counterexamples.",
		commitments: "",
		nodes: [
			{
				nodeId: "n1",
				learned: "Understands chain rule composition.",
				errorsCorrected: "Stopped dropping inner derivative.",
				openPoints: "",
			},
		],
	};

	// plan 001 part 3: parseLessonJudgment strips ```json fence, validates, and returns LessonJudgment without truncating values
	it("accepts a ```json fenced valid object and preserves values without truncation", () => {
		const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
		const res = parseLessonJudgment(fenced, ["n1"]);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value.learnerWide, validPayload.learnerWide);
			assert.equal(res.value.commitments, "");
			assert.deepEqual(res.value.nodes["n1"], {
				learned: "Understands chain rule composition.",
				errorsCorrected: "Stopped dropping inner derivative.",
				openPoints: "",
			});
		}
	});

	// plan 001 part 3: parseLessonJudgment strips surrounding ``` code fence
	it("accepts a plain ``` fenced valid object", () => {
		const fenced = "```\n" + JSON.stringify(validPayload) + "\n```";
		const res = parseLessonJudgment(fenced, ["n1"]);
		assert.equal(res.ok, true);
	});

	// plan 001 part 3: parse failure produces "not valid JSON: <message>"
	it("rejects invalid JSON with exact prefix", () => {
		const res = parseLessonJudgment("{not json", ["n1"]);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.ok(res.problems.some((p) => p.startsWith("not valid JSON: ")));
		}
	});

	// plan 001 part 3: shape validation rejects wrong types
	it("rejects non-object or wrong field types", () => {
		const res = parseLessonJudgment(JSON.stringify({ learnerWide: 123, commitments: "", nodes: "bad" }), ["n1"]);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.ok(res.problems.length > 0);
		}
	});

	// plan 001 part 3: nodes ids must equal taughtIds set with exact error messages for missing, extra, and duplicate
	it("rejects missing, extra, and duplicate node ids with exact messages", () => {
		const res = parseLessonJudgment(
			JSON.stringify({
				learnerWide: "ok",
				commitments: "",
				nodes: [
					{ nodeId: "n1", learned: "a", errorsCorrected: "", openPoints: "" },
					{ nodeId: "n1", learned: "b", errorsCorrected: "", openPoints: "" },
					{ nodeId: "extra", learned: "c", errorsCorrected: "", openPoints: "" },
				],
			}),
			["n1", "missing"],
		);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.ok(res.problems.includes('node "n1" appears twice'));
			assert.ok(res.problems.includes('node "extra" was not taught in this stretch'));
			assert.ok(res.problems.includes('missing entry for node "missing"'));
		}
	});

	// plan 001 part 3: learned must be non-empty after trimming
	it("rejects empty or whitespace-only learned", () => {
		const res = parseLessonJudgment(
			JSON.stringify({
				learnerWide: "ok",
				commitments: "",
				nodes: [{ nodeId: "n1", learned: "   \n ", errorsCorrected: "", openPoints: "" }],
			}),
			["n1"],
		);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.ok(res.problems.length > 0);
		}
	});

	// plan 001 part 3: caps apply after trimming, so padding past the cap is accepted
	it("accepts strings that exceed a cap only through surrounding whitespace", () => {
		const res = parseLessonJudgment(
			JSON.stringify({
				learnerWide: `  ${"w".repeat(1500)}  `,
				commitments: ` ${"c".repeat(600)} `,
				nodes: [
					{
						nodeId: "n1",
						learned: ` ${"l".repeat(400)} `,
						errorsCorrected: ` ${"e".repeat(300)} `,
						openPoints: ` ${"o".repeat(300)} `,
					},
				],
			}),
			["n1"],
		);
		assert.equal(res.ok, true);
	});

	// plan 001 part 3: each string field must be <= its cap after trimming with exact error messages
	it("rejects fields exceeding caps after trimming with exact messages", () => {
		const res = parseLessonJudgment(
			JSON.stringify({
				learnerWide: "w".repeat(1501),
				commitments: "c".repeat(601),
				nodes: [
					{
						nodeId: "n1",
						learned: "l".repeat(401),
						errorsCorrected: "e".repeat(301),
						openPoints: "o".repeat(301),
					},
				],
			}),
			["n1"],
		);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.ok(res.problems.includes("learnerWide is 1501 characters; the limit is 1500"));
			assert.ok(res.problems.includes("commitments is 601 characters; the limit is 600"));
			assert.ok(res.problems.includes('learned of "n1" is 401 characters; the limit is 400'));
			assert.ok(res.problems.includes('errorsCorrected of "n1" is 301 characters; the limit is 300'));
			assert.ok(res.problems.includes('openPoints of "n1" is 301 characters; the limit is 300'));
		}
	});
});

describe("mergeJudgment", () => {
	// plan 001 part 3: mergeJudgment keeps untouched entries byte-for-byte and keeps orphan ids
	it("keeps untouched and orphan entries byte-for-byte while replacing parsed entries", () => {
		const untouched = {
			learned: "Untouched  spacing\nkept.",
			errorsCorrected: "",
			openPoints: "Still open.",
		};
		const orphan = {
			learned: "Orphan node learned.",
			errorsCorrected: "Fixed sign.",
			openPoints: "",
		};
		const previous: LessonJudgment = {
			learnerWide: "Old wide",
			commitments: "Old commitment",
			nodes: {
				n1: { learned: "Old n1", errorsCorrected: "", openPoints: "" },
				n2: untouched,
				"orphan-id": orphan,
			},
		};
		const parsed: LessonJudgment = {
			learnerWide: "New wide",
			commitments: "",
			nodes: {
				n1: { learned: "Updated n1", errorsCorrected: "Fixed n1", openPoints: "" },
				n3: { learned: "New n3", errorsCorrected: "", openPoints: "" },
			},
		};

		const merged = mergeJudgment(previous, parsed);
		assert.equal(merged.learnerWide, "New wide");
		assert.equal(merged.commitments, "");
		assert.deepEqual(merged.nodes["n1"], parsed.nodes["n1"]);
		assert.deepEqual(merged.nodes["n3"], parsed.nodes["n3"]);
		assert.equal(merged.nodes["n2"]?.learned, untouched.learned);
		assert.equal(merged.nodes["n2"]?.errorsCorrected, untouched.errorsCorrected);
		assert.equal(merged.nodes["n2"]?.openPoints, untouched.openPoints);
		assert.deepEqual(merged.nodes["orphan-id"], orphan);
	});

	// plan 001 part 3: mergeJudgment supports empty/absent previous judgment
	it("handles null previous judgment on the first unit cut", () => {
		const parsed: LessonJudgment = {
			learnerWide: "Wide",
			commitments: "None",
			nodes: { n1: { learned: "L1", errorsCorrected: "", openPoints: "" } },
		};
		const merged = mergeJudgment(null, parsed);
		assert.deepEqual(merged, parsed);
	});
});
