import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LESSON_RECORD_HEADER, type LessonJudgment } from "../src/core/contracts/chat.ts";
import { renderLessonRecord } from "../src/core/lesson-record.ts";

describe("renderLessonRecord", () => {
	// plan 001 part 3: renderLessonRecord renders header, facts, per-node judgment, Across the lesson, and Commitments still owed
	it("renders the full lesson record with header, facts, per-node judgment, and commitments", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Limits (finished)",
			"- [visited] Epsilon-delta (n1)",
			"Requires: n1 → n2",
			"## Probe assessment",
			"- algebra: solid",
			"## Current position",
			"Current unit: Unit 2 · Derivatives",
		].join("\n");

		const judgment: LessonJudgment = {
			learnerWide: "Prefers geometric intuition before symbols.",
			commitments: "Revisit Taylor error bound in unit 3.",
			nodes: {
				n1: {
					learned: "Can choose delta from epsilon for linear functions.",
					errorsCorrected: "Stopped treating delta as fixed before epsilon.",
					openPoints: "Needs practice with quadratic bounds.",
				},
			},
		};

		const rendered = renderLessonRecord(facts, judgment);
		assert.ok(rendered.startsWith(LESSON_RECORD_HEADER));
		assert.ok(rendered.includes("## Plan"));
		assert.ok(rendered.includes("## Probe assessment"));
		assert.ok(rendered.includes("## Current position"));
		assert.ok(rendered.includes("## The learner, per node"));
		assert.ok(rendered.includes("### Epsilon-delta (n1)"));
		assert.ok(rendered.includes("Learned: Can choose delta from epsilon for linear functions."));
		assert.ok(rendered.includes("Errors corrected: Stopped treating delta as fixed before epsilon."));
		assert.ok(rendered.includes("Open points: Needs practice with quadratic bounds."));
		assert.ok(rendered.includes("## Across the lesson\nPrefers geometric intuition before symbols."));
		assert.ok(rendered.includes("## Commitments still owed\nRevisit Taylor error bound in unit 3."));
	});

	// plan 001 part 3: rendering omits empty Errors corrected / Open points lines and renders "none" for empty commitments
	it("omits empty Errors corrected and Open points lines and renders none for empty commitments", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Limits (finished)",
			"- [visited] Epsilon-delta (n1)",
			"## Current position",
			"Current unit: Unit 2 · Derivatives",
		].join("\n");

		const judgment: LessonJudgment = {
			learnerWide: "Steady pace.",
			commitments: "",
			nodes: {
				n1: {
					learned: "Grasps the core idea.",
					errorsCorrected: "",
					openPoints: "",
				},
			},
		};

		const rendered = renderLessonRecord(facts, judgment);
		assert.ok(rendered.includes("Learned: Grasps the core idea."));
		assert.equal(rendered.includes("Errors corrected:"), false);
		assert.equal(rendered.includes("Open points:"), false);
		assert.ok(rendered.includes("## Commitments still owed\nnone"));
	});

	// plan 001 part 3: rendering omits empty Taught, no longer in the plan and absent Probe assessment sections
	it("omits empty Taught, no longer in the plan and absent Probe assessment sections", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Limits (finished)",
			"- [visited] Epsilon-delta (n1)",
			"## Current position",
			"Current unit: Unit 2 · Derivatives",
		].join("\n");

		const judgment: LessonJudgment = {
			learnerWide: "Steady pace.",
			commitments: "",
			nodes: {
				n1: { learned: "Done.", errorsCorrected: "", openPoints: "" },
			},
		};

		const rendered = renderLessonRecord(facts, judgment);
		assert.equal(rendered.includes("## Taught, no longer in the plan"), false);
		assert.equal(rendered.includes("## Probe assessment"), false);
	});

	// plan 001 part 3: per-node entries render in plan order, orphans after
	it("renders per-node entries in plan order with orphans after", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Limits (finished)",
			"- [visited] First (n1)",
			"- [visited] Second (n2)",
			"## Current position",
			"Current unit: Unit 2 · Derivatives",
		].join("\n");
		const entry = (learned: string) => ({ learned, errorsCorrected: "", openPoints: "" });
		const judgment: LessonJudgment = {
			learnerWide: "w",
			commitments: "",
			nodes: {
				"old-node": entry("orphan"),
				n2: entry("second"),
				n1: entry("first"),
			},
		};
		const rendered = renderLessonRecord(facts, judgment);
		const at = (s: string) => rendered.indexOf(s);
		assert.ok(at("### First (n1)") >= 0);
		assert.ok(at("### First (n1)") < at("### Second (n2)"));
		assert.ok(at("Learned: first") < at("Learned: second"));
		assert.ok(at("Learned: orphan") > at("Learned: second"));
	});

	// plan 001 part 3: rendering includes orphan judgment entries for ids no longer in the plan
	it("renders judgment entries for orphan node ids no longer in the plan", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Limits (finished)",
			"- [visited] Epsilon-delta (n1)",
			"## Current position",
			"Current unit: Unit 2 · Derivatives",
		].join("\n");

		const judgment: LessonJudgment = {
			learnerWide: "Steady pace.",
			commitments: "",
			nodes: {
				n1: { learned: "Current node learned.", errorsCorrected: "", openPoints: "" },
				"old-node": { learned: "Orphan node learned.", errorsCorrected: "", openPoints: "" },
			},
		};

		const rendered = renderLessonRecord(facts, judgment);
		assert.ok(rendered.includes("old-node"));
		assert.ok(rendered.includes("Learned: Orphan node learned."));
	});
});
