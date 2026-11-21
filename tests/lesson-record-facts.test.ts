import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { checkLines, recordFacts } from "../src/core/lesson-record.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const makeTeachCall = (
	msgId: string,
	callId: string,
	tool: "quiz" | "explain",
	args: Record<string, unknown>,
	extra?: Record<string, unknown>,
): LhMessage =>
	({
		id: msgId,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: tool, arguments: args }],
		timestamp: 1,
		...extra,
	}) as never;

const makeAnswerResult = (
	msgId: string,
	callId: string,
	tool: "quiz" | "explain",
	details: QuestionAnswerData | null | undefined,
	isError = false,
): LhMessage =>
	({
		id: msgId,
		role: "toolResult",
		toolCallId: callId,
		toolName: tool,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp: 2,
	}) as never;

const makeProbeDone = (
	assistantId: string,
	resultId: string,
	callId: string,
	strands: Array<{ strand: string; assessment: string }>,
	summary?: string,
	ok = true,
): LhMessage[] => [
	{
		id: assistantId,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "probe_done",
				arguments: { assessment: { strands, ...(summary !== undefined ? { summary } : {}) } },
			},
		],
		timestamp: 1,
	} as never,
	{
		id: resultId,
		role: "toolResult",
		toolCallId: callId,
		toolName: "probe_done",
		content: [{ type: "text", text: "ok" }],
		details: { ok },
		isError: false,
		timestamp: 2,
	} as never,
];

describe("checkLines", () => {
	// plan 001 part 3: 3 tagged quizzes (right; wrong with two picks; dismissed), 1 explain, 1 don't-know and 1 unanswered call produce exact check lines and no line for the unanswered call
	it("formats answered tagged quiz/explain calls in transcript order and skips unanswered calls", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", type: "predict", question: "Q1" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "What is 2+2?",
				dontKnow: false,
				answers: [{ label: "4", value: "4", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
			makeTeachCall("a2", "c2", "quiz", { nodeId: "n1", type: "check", question: "Q2" }),
			makeAnswerResult("r2", "c2", "quiz", {
				kind: "quiz",
				questionText: "Which are prime?",
				dontKnow: false,
				answers: [
					{ label: "4", value: "4", index: 1 },
					{ label: "9", value: "9", index: 2 },
				],
				correct: false,
				answeredAt: "2026-11-20T00:00:01.000Z",
			}),
			makeTeachCall("a3", "c3", "quiz", { nodeId: "n1", type: "check", question: "Q3" }),
			makeAnswerResult("r3", "c3", "quiz", {
				kind: "quiz",
				questionText: "Skipped quiz",
				dontKnow: false,
				answers: [],
				dismissed: true,
				answeredAt: "2026-11-20T00:00:02.000Z",
			}),
			makeTeachCall("a4", "c4", "explain", { nodeId: "n2", type: "check", question: "E1" }),
			makeAnswerResult("r4", "c4", "explain", {
				kind: "explain",
				questionText: "Explain why",
				dontKnow: false,
				answers: [],
				text: "Because slopes add",
				answeredAt: "2026-11-20T00:00:03.000Z",
			}),
			makeTeachCall("a5", "c5", "quiz", { nodeId: "n2", type: "predict", question: "Q4" }),
			makeAnswerResult("r5", "c5", "quiz", {
				kind: "quiz",
				questionText: "Hard question",
				dontKnow: true,
				answers: [],
				answeredAt: "2026-11-20T00:00:04.000Z",
			}),
			// Unanswered call
			makeTeachCall("a6", "c6", "quiz", { nodeId: "n2", type: "check", question: "Unanswered" }),
		];

		const lines = checkLines(msgs);
		assert.deepEqual(lines.get("n1"), [
			'predict — "What is 2+2?" — right',
			'check — "Which are prime?" — wrong (picked "4", "9")',
			'check — "Skipped quiz" — skipped',
		]);
		assert.deepEqual(lines.get("n2"), [
			'check — "Explain why" — own words, ungraded: "Because slopes add"',
			'predict — "Hard question" — didn\'t know',
		]);
	});

	// plan 001 part 3: stem is whitespace-collapsed and clipped to CHECK_STEM_CLIP (120) + "…"
	it("collapses whitespace and clips a 130-character stem to 120 + ellipsis", () => {
		const stem130 = `${"a".repeat(60)}\n  ${"b".repeat(68)}`; // collapses to 60 + 1 + 68 = 129? Let's make exact 130 after collapse
		const exact130 = "x".repeat(130);
		assert.equal(exact130.length, 130);
		assert.ok(stem130.includes("\n"));

		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", question: "q" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: exact130,
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
			makeTeachCall("a2", "c2", "quiz", { nodeId: "n1", question: "q2" }),
			makeAnswerResult("r2", "c2", "quiz", {
				kind: "quiz",
				questionText: "hello   \n\t  world",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:01.000Z",
			}),
		];

		const lines = checkLines(msgs);
		assert.equal(lines.get("n1")?.[0], `check — "${"x".repeat(120)}…" — right`);
		assert.equal(lines.get("n1")?.[1], 'check — "hello world" — right');
	});

	// plan 001 part 3: checkLines role is call input type (predict | check), defaulting to check when absent
	it("defaults role to check when type is absent", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", question: "q" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "No type",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
		];
		assert.deepEqual(checkLines(msgs).get("n1"), ['check — "No type" — right']);
	});

	// plan 001 part 3: explain outcome clips text to EXPLAIN_ANSWER_CLIP (160) + "…"
	it("clips explain answer text longer than 160 characters to 160 + ellipsis", () => {
		const longText = "y".repeat(175);
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "explain", { nodeId: "n1", question: "e" }),
			makeAnswerResult("r1", "c1", "explain", {
				kind: "explain",
				questionText: "Explain",
				dontKnow: false,
				answers: [],
				text: longText,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
		];
		assert.deepEqual(checkLines(msgs).get("n1"), [
			`check — "Explain" — own words, ungraded: "${"y".repeat(160)}…"`,
		]);
	});

	// plan 001 part 3: otherwise → "answered" (quiz with no dismissed/dontKnow/correct)
	it("falls back to answered when a quiz has no verdict", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", type: "check", question: "q" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Ungraded quiz",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
		];
		assert.deepEqual(checkLines(msgs).get("n1"), ['check — "Ungraded quiz" — answered']);
	});

	// plan 001 part 3: only calls with a nodeId produce a check line
	it("produces no line for answered calls without a nodeId", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { question: "q" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Untagged",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
			makeTeachCall("a2", "c2", "explain", { question: "e" }),
			makeAnswerResult("r2", "c2", "explain", {
				kind: "explain",
				questionText: "Untagged explain",
				dontKnow: false,
				answers: [],
				text: "words",
				answeredAt: "2026-11-20T00:00:01.000Z",
			}),
		];
		assert.equal(checkLines(msgs).size, 0);
	});

	// plan 001 part 3: plugin questions produce no line (spec choice 4)
	it("ignores plugin questions", () => {
		const msgs: LhMessage[] = [
			makeTeachCall(
				"a1",
				"c1",
				"quiz",
				{ nodeId: "n1", question: "q" },
				{
					lhQuestions: {
						"0": {
							status: "posed",
							snapshot: {
								variant: "teach",
								input: { nodeId: "n1", question: "q" },
							},
						},
					},
				},
			),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Plugin Q",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
		];
		assert.equal(checkLines(msgs).size, 0);
	});

	// plan 001 part 3: answered means matching toolResult exists, is not isError, and has object details
	it("skips error results and results without object details", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", question: "q1" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Err",
				dontKnow: false,
				answers: [],
				answeredAt: "2026-11-20T00:00:00.000Z",
			}, true),
			makeTeachCall("a2", "c2", "quiz", { nodeId: "n1", question: "q2" }),
			makeAnswerResult("r2", "c2", "quiz", null, false),
		];
		assert.equal(checkLines(msgs).size, 0);
	});
});

describe("recordFacts", () => {
	const twoUnitTree: PlanTree = {
		version: 1,
		nodes: [
			{ id: "n1", title: "Limits" },
			{ id: "n2", title: "Derivatives" },
			{ id: "n3", title: "Chain rule" },
		],
		edges: [
			{ from: "n1", to: "n2" },
			{ from: "n2", to: "n3" },
		],
		units: [
			{ id: "u1", title: "Foundations", source: "ch1.pdf", nodeIds: ["n1", "n2"] },
			{ id: "u2", title: "Rules", nodeIds: ["n3"] },
		],
	};

	// plan 001 part 3: recordFacts formats Plan units, node statuses, check lines, Requires edges, and Current position
	it("renders facts for a two-unit tree with statuses, check lines, edges, and current position", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "n1", type: "check", question: "Q1" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Limit check",
				dontKnow: false,
				answers: [{ label: "0", value: "0", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
			makeTeachCall("a2", "c2", "quiz", { nodeId: "n3", type: "predict", question: "Q2" }),
		];

		const facts = recordFacts(twoUnitTree, msgs, ["u1"], "u2");
		assert.ok(facts.includes("Unit 1 · Foundations (finished) — source: ch1.pdf"));
		assert.ok(facts.includes("- [visited] Limits (n1)"));
		assert.ok(facts.includes('    · check — "Limit check" — right'));
		assert.ok(facts.includes("- [upcoming] Derivatives (n2)"));
		assert.ok(facts.includes("Unit 2 · Rules (current)"));
		assert.ok(facts.includes("- [current] Chain rule (n3)"));
		assert.ok(facts.includes("Requires: n1 → n2, n2 → n3"));
		assert.ok(facts.includes("Current unit: Unit 2 · Rules"));
		assert.ok(facts.includes("current node: Chain rule (n3)"));
		assert.equal(facts.includes("Taught, no longer in the plan"), false);
		assert.equal(facts.includes("Probe assessment"), false);
	});

	// plan 001 part 3: recordFacts includes Taught, no longer in the plan when orphan check lines exist and omits it when empty
	it("includes Taught, no longer in the plan when check lines exist for removed nodes", () => {
		const msgs: LhMessage[] = [
			makeTeachCall("a1", "c1", "quiz", { nodeId: "removed-node", type: "check", question: "Old" }),
			makeAnswerResult("r1", "c1", "quiz", {
				kind: "quiz",
				questionText: "Old check",
				dontKnow: false,
				answers: [{ label: "A", value: "A", index: 1 }],
				correct: true,
				answeredAt: "2026-11-20T00:00:00.000Z",
			}),
		];

		const facts = recordFacts(twoUnitTree, msgs, [], "u1");
		assert.ok(facts.includes("Taught, no longer in the plan"));
		assert.ok(facts.includes("- (removed-node)"));
		assert.ok(facts.includes('    · check — "Old check" — right'));
	});

	// plan 001 part 3: recordFacts includes Probe assessment from first successful probe_done and omits it when absent
	it("includes Probe assessment from the first successful probe_done", () => {
		const msgs: LhMessage[] = [
			...makeProbeDone(
				"p1",
				"pr1",
				"pc1",
				[{ strand: "algebra", assessment: "solid on quadratics" }],
				"Ready for calculus",
				true,
			),
			// Second probe_done should not override the first
			...makeProbeDone(
				"p2",
				"pr2",
				"pc2",
				[{ strand: "other", assessment: "ignored" }],
				"Ignored summary",
				true,
			),
		];

		const facts = recordFacts(twoUnitTree, msgs, [], "u1");
		assert.ok(facts.includes("Probe assessment"));
		assert.ok(facts.includes("- algebra: solid on quadratics"));
		assert.ok(facts.includes("Summary: Ready for calculus"));
		assert.equal(facts.includes("other"), false);
	});

	// plan 001 part 3: the probe assessment comes from the first SUCCESSFUL probe_done; a failed one is skipped
	it("skips an unsuccessful probe_done before the first successful one", () => {
		const msgs: LhMessage[] = [
			...makeProbeDone("p0", "pr0", "pc0", [{ strand: "failed", assessment: "nope" }], "Failed summary", false),
			...makeProbeDone("p1", "pr1", "pc1", [{ strand: "algebra", assessment: "solid" }], "Good summary", true),
		];
		const facts = recordFacts(twoUnitTree, msgs, [], "u1");
		assert.ok(facts.includes("- algebra: solid"));
		assert.ok(facts.includes("Summary: Good summary"));
		assert.equal(facts.includes("failed"), false);
		assert.equal(facts.includes("Failed summary"), false);
	});

	// plan 001 part 3: a unit after the current one that is not finished is "(upcoming)"
	it("marks a later unfinished unit as upcoming", () => {
		const tree: PlanTree = {
			...twoUnitTree,
			nodes: [...twoUnitTree.nodes, { id: "n4", title: "Integrals" }],
			units: [
				...(twoUnitTree.units ?? []),
				{ id: "u3", title: "Integration", nodeIds: ["n4"] },
			],
		};
		const facts = recordFacts(tree, [], ["u1"], "u2");
		assert.ok(facts.includes("Unit 3 · Integration (upcoming)"));
	});

	// plan 001 part 3: a tree without units renders the nodes flat under Plan
	it("renders nodes flat under Plan when tree has no units", () => {
		const flatTree: PlanTree = {
			version: 1,
			nodes: [{ id: "n1", title: "Limits" }],
			edges: [],
		};
		const facts = recordFacts(flatTree, [], [], "u1");
		assert.ok(facts.includes("Plan"));
		assert.ok(facts.includes("- [upcoming] Limits (n1)"));
	});
});
