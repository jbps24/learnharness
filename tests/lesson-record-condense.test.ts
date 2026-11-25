import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { condenseLessonRecordPlan, renderLessonRecord } from "../src/core/lesson-record.ts";
import { LESSON_RECORD_HEADER, newUserMessage, toLlmMessages, type LhMarkerMessage, type LhMessage } from "../src/core/index.ts";

function buildLargePlanFixture(): string {
	const lines: string[] = [
		"## Plan",
		"Unit 1 · Linear prediction and orthogonality (finished) — source: notes/dsp-ch4.pdf",
		"- [visited] Least squares: error orthogonal to regressors (orth)",
		'    · check — "What is the orthogonality principle?" — right',
		'    · check — "When is $e[n]$ orthogonal to $x[n-1]$?" — didn\'t know',
		'    · predict — "Does $E\\{e[n]\\,x[n]\\}=0$ hold for $p=1$?" — right',
		'    · check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know',
		"- [visited] Autocorrelation matrix structure (autocorr)",
		'    · check — "Why is $R_x$ Toeplitz for a WSS process?" — right',
		'    · check — "Is $R_x$ always positive semidefinite?" — right',
		"- [upcoming] Levinson-Durbin recursion (levinson)",
	];
	for (let i = 1; i <= 34; i++) {
		const id = `n${i}`;
		lines.push(`- [visited] Filter design topic ${i}: spectral factorization and lattice realization (${id})`);
		for (let q = 1; q <= 5; q++) {
			// most nodes were answered all right; every fourth node has one wrong answer
			const outcome = i % 4 === 0 && q === 3 ? 'wrong (picked "Option B: all-pole only")' : "right";
			lines.push(
				`    · check — "In step ${q} of topic ${i}, how do reflection coefficients relate to predictor error variance?" — ${outcome}`,
			);
		}
	}
	lines.push("Requires: orth → autocorr, autocorr → levinson");
	return lines.join("\n");
}

describe("condenseLessonRecordPlan", () => {
	// plan 022 part 2: the orth block becomes the confirmed example
	it("condenses the orth block into the confirmed format", () => {
		const input = [
			"## Plan",
			"Unit 1 · Linear prediction (finished)",
			"- [visited] Least squares: error orthogonal to regressors (orth)",
			'    · check — "What is the orthogonality principle?" — right',
			'    · check — "When is $e[n]$ orthogonal to $x[n-1]$?" — didn\'t know',
			'    · predict — "Does $E\\{e[n]\\,x[n]\\}=0$ hold for $p=1$?" — right',
			'    · check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know',
		].join("\n");

		const expected = [
			"## Plan",
			"Unit 1 · Linear prediction (finished)",
			"- [visited] Least squares: error orthogonal to regressors (orth)",
			"    · 4 asked: 2 right, 2 didn't know",
			'    · newest gap: check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know',
		].join("\n");

		assert.equal(condenseLessonRecordPlan(input), expected);
	});

	// plan 022 part 2: result category strips trailing " (…)" while newest gap keeps full result
	it("strips trailing parentheticals for category counts while keeping full result in newest gap", () => {
		const input = [
			"## Plan",
			"- [visited] Normal equations (normeq)",
			'    · check — "Which matrix is inverted?" — wrong (picked "R^T")',
			'    · explain — "State the normal equations." — own words, ungraded: "R a = r"',
			'    · check — "Is the solution unique?" — right',
		].join("\n");

		const expected = [
			"## Plan",
			"- [visited] Normal equations (normeq)",
			'    · 3 asked: 1 wrong, 1 own words, ungraded: "R a = r", 1 right',
			'    · newest gap: explain — "State the normal equations." — own words, ungraded: "R a = r"',
		].join("\n");

		assert.equal(condenseLessonRecordPlan(input), expected);
	});

	// plan 022 part 2: counts list categories in order of first appearance under that node
	it("lists category counts in order of first appearance and picks the last non-right line as newest gap", () => {
		const input = [
			"## Plan",
			"- [visited] Yule-Walker (yw)",
			'    · check — "Q1" — skipped',
			'    · check — "Q2" — right',
			'    · predict — "Q3" — wrong (picked "A")',
			'    · check — "Q4" — right',
		].join("\n");

		const expected = [
			"## Plan",
			"- [visited] Yule-Walker (yw)",
			"    · 4 asked: 1 skipped, 2 right, 1 wrong",
			'    · newest gap: predict — "Q3" — wrong (picked "A")',
		].join("\n");

		assert.equal(condenseLessonRecordPlan(input), expected);
	});

	// plan 022 part 2: an all-right node keeps only its counts line
	it("keeps only the counts line for an all-right node", () => {
		const input = [
			"## Plan",
			"- [visited] Autocorrelation matrix structure (autocorr)",
			'    · check — "Why is $R_x$ Toeplitz?" — right',
			'    · check — "Is $R_x$ positive semidefinite?" — right',
		].join("\n");

		const expected = [
			"## Plan",
			"- [visited] Autocorrelation matrix structure (autocorr)",
			"    · 2 asked: 2 right",
		].join("\n");

		assert.equal(condenseLessonRecordPlan(input), expected);
	});

	// plan 022 part 2: a node without questions keeps only its node line
	it("keeps only the node line when a node has no questions", () => {
		const input = [
			"## Plan",
			"- [upcoming] Levinson-Durbin recursion (levinson)",
			"- [visited] Next topic (next)",
			'    · check — "Q" — right',
		].join("\n");

		const expected = [
			"## Plan",
			"- [upcoming] Levinson-Durbin recursion (levinson)",
			"- [visited] Next topic (next)",
			"    · 1 asked: 1 right",
		].join("\n");

		assert.equal(condenseLessonRecordPlan(input), expected);
	});

	// plan 022 part 2: text outside "## Plan" is byte-identical
	it("leaves text outside the ## Plan section byte-identical", () => {
		const before = `${LESSON_RECORD_HEADER}\n\n`;
		const plan = [
			"## Plan",
			"Unit 1 · Basics (finished) — source: ch1.pdf",
			"- [visited] Node A (a)",
			'    · check — "Q1" — right',
			'    · check — "Q2" — didn\'t know',
			"Requires: a → b",
		].join("\n");
		const after = [
			"",
			"## Taught, no longer in the plan",
			"- (old)",
			'    · check — "Legacy?" — wrong (picked "X")',
			"## Probe assessment",
			"- Algebra: solid",
			"## Current position",
			"Current unit: Unit 2 · Next",
			"## The learner, per node",
			"### Node A (a)",
			"Learned: understands basics",
			"## Across the lesson",
			"Prefers derivations.",
			"## Commitments still owed",
			"none",
		].join("\n");

		const condensed = condenseLessonRecordPlan(before + plan + after);
		assert.equal(condensed.startsWith(before), true);
		assert.equal(condensed.endsWith(after), true);
	});

	// plan 022 part 2: condensing twice equals condensing once
	it("is idempotent", () => {
		const fixture = buildLargePlanFixture();
		const once = condenseLessonRecordPlan(fixture);
		const twice = condenseLessonRecordPlan(once);
		assert.equal(twice, once);
	});

	// plan 022 part 2: the ~23 KB "## Plan" fixture shrinks to under 9 KB
	it("shrinks the ~23 KB ## Plan fixture to under 9 KB", () => {
		const fixture = buildLargePlanFixture();
		const rawBytes = Buffer.byteLength(fixture, "utf8");
		assert.equal(rawBytes >= 22_000, true, `expected fixture >= 22 KB, got ${rawBytes}`);
		const condensed = condenseLessonRecordPlan(fixture);
		assert.equal(condensed.includes("    · 5 asked: 5 right"), true);
		const condensedBytes = Buffer.byteLength(condensed, "utf8");
		assert.equal(condensedBytes < 9_000, true, `expected condensed < 9 KB, got ${condensedBytes}`);
	});

	// plan 022 part 2: renderLessonRecord applies condenseLessonRecordPlan to new records
	it("is applied by renderLessonRecord to new records", () => {
		const facts = [
			"## Plan",
			"Unit 1 · Linear prediction (finished)",
			"- [visited] Least squares: error orthogonal to regressors (orth)",
			'    · check — "What is the orthogonality principle?" — right',
			'    · check — "When is $e[n]$ orthogonal to $x[n-1]$?" — didn\'t know',
			'    · predict — "Does $E\\{e[n]\\,x[n]\\}=0$ hold for $p=1$?" — right',
			'    · check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know',
			"## Current position",
			"Current unit: Unit 2 · Estimation",
		].join("\n");

		const rendered = renderLessonRecord(facts, {
			learnerWide: "Works carefully.",
			commitments: "",
			nodes: {
				orth: { learned: "Knows the p=1 case.", errorsCorrected: "", openPoints: "p=2 condition." },
			},
		});

		assert.equal(rendered.includes("    · 4 asked: 2 right, 2 didn't know"), true);
		assert.equal(
			rendered.includes('    · newest gap: check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know'),
			true,
		);
		assert.equal(rendered.includes('    · check — "What is the orthogonality principle?" — right'), false);
	});

	// plan 022 part 2: toLlmMessages projection condenses stored lesson-record markers without mutating the record
	it("is applied by toLlmMessages to stored lesson-record markers without mutating them", () => {
		const rawContent = [
			LESSON_RECORD_HEADER,
			"",
			"## Plan",
			"Unit 1 · Linear prediction (finished)",
			"- [visited] Least squares: error orthogonal to regressors (orth)",
			'    · check — "What is the orthogonality principle?" — right',
			'    · check — "When is $e[n]$ orthogonal to $x[n-1]$?" — didn\'t know',
			'    · predict — "Does $E\\{e[n]\\,x[n]\\}=0$ hold for $p=1$?" — right',
			'    · check — "For a $p=2$ predictor, the condition $E\\{e[n]\\,x[n-2]\\}=0$ …" — didn\'t know',
			"## Current position",
			"Current unit: Unit 2 · Estimation",
		].join("\n");

		const kept = { ...newUserMessage("Continue unit 2"), id: "m_kept" } as LhMessage;
		const marker: LhMarkerMessage = {
			id: "lr_1",
			role: "custom",
			customType: "lesson-record",
			content: rawContent,
			display: true,
			details: {
				firstKeptMessageId: "m_kept",
				finishedUnitIds: ["u1"],
				currentUnitId: "u2",
				judgment: { learnerWide: "", commitments: "", nodes: {} },
				at: "2026-11-25T00:00:00.000Z",
			},
			timestamp: 1,
		};

		const wire = toLlmMessages([marker, kept]);
		const headText = (wire[0] as { content: Array<{ text: string }> }).content[0]!.text;
		assert.equal(headText.includes("    · 4 asked: 2 right, 2 didn't know"), true);
		assert.equal(headText.includes('    · check — "What is the orthogonality principle?" — right'), false);
		assert.equal(marker.content, rawContent);
	});

	// X1-0: multi-line (including two-paragraph) stored explain answer collapses without splitting the node group
	it("collapses multi-line stored explain answers without splitting the node group", () => {
		const input = [
			"## Plan",
			"Unit 1 · Linear prediction (current)",
			"- [visited] Normal equations (normeq)",
			'    · explain — "State the normal equations." — own words, ungraded: "First paragraph line one',
			"line two",
			"",
			'Second paragraph."',
			'    · check — "Is R symmetric?" — right',
			"- [upcoming] Levinson-Durbin (levinson)",
		].join("\n");

		const expected = [
			"## Plan",
			"Unit 1 · Linear prediction (current)",
			"- [visited] Normal equations (normeq)",
			'    · 2 asked: 1 own words, ungraded: "First paragraph line one line two Second paragraph.", 1 right',
			'    · newest gap: explain — "State the normal equations." — own words, ungraded: "First paragraph line one line two Second paragraph."',
			"- [upcoming] Levinson-Durbin (levinson)",
		].join("\n");

		const condensed = condenseLessonRecordPlan(input);
		assert.equal(condensed, expected);
		assert.equal(condenseLessonRecordPlan(condensed), condensed);
	});
});
