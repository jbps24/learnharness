import React, { createElement } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { UnitCutDivider, type UnitCutDividerData } from "../components/compaction-divider.tsx";
import { PathText } from "../components/file-path-chip.tsx";
import { PlanBlock } from "../components/plan-block.tsx";
import { ConcludeCard, ProblemCard } from "../components/practice-cards.tsx";
import { partFindRanges } from "../components/session-find-dom.ts";
import { SideThreadBody } from "../components/side-thread.tsx";
import type { PlanBlockData, SideChatThread } from "../src/core/contracts/chat.ts";
import { findHits, findUnits, type FindUnit } from "../src/core/find-text.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { projectView } from "../src/core/view.ts";

function assertParity(
	unit: FindUnit | undefined,
	element: React.ReactElement,
	queries: readonly [word: string, phrase: string, umlaut: string],
): void {
	assert.ok(unit, "expected FindUnit for fixture");
	const html = renderToStaticMarkup(element);
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const partEl = document.querySelector(`[data-find-part="${unit.key}"]`) as unknown as HTMLElement | null;
	assert.ok(partEl, `expected [data-find-part="${unit.key}"] in rendered markup`);
	for (const query of queries) {
		const expected: number = findHits([unit], query).length;
		assert.ok(expected > 0, `${unit.kind}: expected extractor hits for ${JSON.stringify(query)}`);
		assert.equal(
			partFindRanges(partEl, query).length,
			expected,
			`${unit.kind}: DOM hit count must match extractor for ${JSON.stringify(query)}`,
		);
	}
}

describe("find parity per card kind", () => {
	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for You
	it("matches You user messages across word, phrase, and umlaut queries", () => {
		const text = "I checked the Kettenregel derivation and found an über-clear step.";
		const native: LhMessage[] = [{ id: "u1", role: "user", content: text, timestamp: 10 } as never];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "You");
		assert.ok(unit);
		assertParity(
			unit,
			createElement(
				"div",
				{ "data-find-part": unit.key },
				createElement("div", null, "You"),
				createElement("div", null, createElement(PathText, { text })),
			),
			["derivation", "Kettenregel derivation", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Teacher
	it("matches Teacher prose across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "text", text: "Let us derive the **Produktregel** step by step for an über-smooth curve." }],
				timestamp: 20,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Teacher");
		const part = view[0]?.parts.find((p) => p.type === "text");
		assert.ok(unit && part?.text);
		assertParity(
			unit,
			createElement("div", { "data-find-part": unit.key }, createElement(MessageResponse, null, part.text)),
			["Produktregel", "step by step", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Check
	it("matches Check answered cards across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "q1",
						name: "quiz",
						arguments: {
							question: "Which **eigenvalue** satisfies the characteristic polynomial for an über-symmetric matrix?",
							details: "Consider real matrices.",
							options: [
								{ label: "Lambda one", value: "l1" },
								{ label: "Lambda two", value: "l2" },
							],
							correctAnswer: "l1",
						},
					},
				],
				timestamp: 30,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [],
				isError: false,
				details: {
					kind: "quiz",
					questionText: "Which **eigenvalue** satisfies the characteristic polynomial for an über-symmetric matrix?",
					dontKnow: false,
					answers: [{ index: 1, label: "Lambda one", value: "l1" }],
					options: [
						{ index: 1, label: "Lambda one" },
						{ index: 2, label: "Lambda two" },
					],
					correct: true,
					correctIndices: [1],
					answeredAt: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 31,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Check");
		const part = view[0]?.parts.find((p) => p.type === "tool-quiz");
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(AnsweredCard, {
				answer: part.output as QuestionAnswerData,
				input: part.input,
				toolCallId: part.toolCallId,
				findKey: unit.key,
			}),
			["eigenvalue", "characteristic polynomial", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Question
	it("matches Question answered cards across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "ask1",
						name: "ask_user_question",
						arguments: {
							question: "How is the pacing so far?",
							details: "Pick what helps most for a worked example with über-clear steps.",
							options: [
								{ label: "More worked examples", value: "more", description: "Step-by-step derivations" },
								{ label: "Keep current pace", value: "keep" },
							],
						},
					},
				],
				timestamp: 40,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "ask1",
				toolName: "ask_user_question",
				content: [],
				isError: false,
				details: {
					kind: "ask",
					questionText: "How is the pacing so far?",
					dontKnow: false,
					answers: [{ index: 1, label: "More worked examples", value: "more" }],
					options: [
						{ index: 1, label: "More worked examples" },
						{ index: 2, label: "Keep current pace" },
					],
					answeredAt: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 41,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Question");
		const part = view[0]?.parts.find((p) => p.type === "tool-ask_user_question");
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(AnsweredCard, {
				answer: part.output as QuestionAnswerData,
				input: part.input,
				toolCallId: part.toolCallId,
				findKey: unit.key,
			}),
			["pacing", "worked example", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Problem
	it("matches Problem cards across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "p1",
						name: PRACTICE_PROBLEM_TOOL,
						arguments: {
							statement: "Compute the **integral** of an über-oscillating function using integration by parts.",
						},
					},
				],
				timestamp: 50,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Problem");
		const part = view[0]?.parts.find((p) => p.type === `tool-${PRACTICE_PROBLEM_TOOL}`);
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(
				"div",
				{ "data-find-part": unit.key },
				createElement(ProblemCard, {
					part: {
						type: part.type,
						state: part.state ?? "input-available",
						toolCallId: part.toolCallId ?? "p1",
						input: part.input,
					},
				}),
			),
			["integral", "integration by parts", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Solution
	it("matches Solution conclude cards across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "p1",
						name: PRACTICE_PROBLEM_TOOL,
						arguments: {
							statement: "Solve the equation.",
							modelSolution: "Apply **substitution** to simplify the über-nested radical.",
						},
					},
				],
				timestamp: 60,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "p1",
				toolName: PRACTICE_PROBLEM_TOOL,
				content: [],
				isError: false,
				timestamp: 61,
			} as never,
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: PRACTICE_CONCLUDE_TOOL,
						arguments: {
							outcome: "solved",
							verdict: "Clean algebraic reduction.",
						},
					},
				],
				timestamp: 62,
			} as never,
			{
				id: "r2",
				role: "toolResult",
				toolCallId: "c1",
				toolName: PRACTICE_CONCLUDE_TOOL,
				content: [],
				isError: false,
				timestamp: 63,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Solution");
		const part = view[0]?.parts.find((p) => p.type === `tool-${PRACTICE_CONCLUDE_TOOL}`);
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(
				"div",
				{ "data-find-part": unit.key },
				createElement(ConcludeCard, {
					part: {
						type: part.type,
						state: part.state ?? "output-available",
						toolCallId: part.toolCallId ?? "c1",
						input: part.input,
						reveal: part.reveal,
						problemInput: part.problemInput,
					},
				}),
			),
			["substitution", "algebraic reduction", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Plan
	it("matches Plan blocks across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "pi1", name: "plan_init", arguments: {} }],
				timestamp: 70,
			} as never,
			{
				id: "pr1",
				role: "toolResult",
				toolCallId: "pi1",
				toolName: "plan_init",
				content: [],
				isError: false,
				details: {
					ok: true,
					tree: {
						nodes: [
							{ id: "n1", title: "Derivatives", status: "current" },
							{ id: "n2", title: "Chain rule", status: "upcoming" },
							{ id: "n3", title: "Überblick", status: "upcoming" },
						],
						edges: [
							{ from: "n1", to: "n2" },
							{ from: "n2", to: "n3" },
						],
						version: 1,
					},
				},
				timestamp: 71,
			} as never,
			{
				id: "pb1",
				role: "custom",
				customType: "plan-block",
				content: "",
				display: true,
				details: {
					planCallId: "pi1",
					block: {
						kind: "full",
						at: "2026-11-22T00:00:00.000Z",
						current: "n1",
						nodes: [
							{ id: "n1", title: "Derivatives", status: "current" },
							{ id: "n2", title: "Chain rule", status: "upcoming" },
							{ id: "n3", title: "Überblick", status: "upcoming" },
						],
						edges: [
							{ from: "n1", to: "n2" },
							{ from: "n2", to: "n3" },
						],
					},
				},
				timestamp: 72,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Plan");
		const part = view[0]?.parts.find((p) => p.type === "data-plan-block");
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(
				"div",
				{ "data-find-part": unit.key },
				createElement(PlanBlock, { data: part.data as PlanBlockData, onOpen: () => {} }),
			),
			["Derivatives", "Chain rule", "Uberblick"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Side chat
	it("matches Side chat messages across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "text", text: "Base explanation." }],
				timestamp: 80,
			} as never,
		];
		const sideThreads: SideChatThread[] = [
			{
				id: "t1",
				anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "Base explanation." },
				open: false,
				createdAt: "2026-11-22T10:00:00.000Z",
				messages: [
					{
						id: "sm1",
						role: "user",
						text: "Why does the chain rule need an über-careful step here?",
						at: "2026-11-22T10:00:01.000Z",
					},
				],
			},
		];
		const units = findUnits({ native, view: projectView(native), sideThreads, pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Side chat");
		assert.ok(unit);
		assertParity(
			unit,
			createElement(SideThreadBody, {
				state: {
					threadId: "t1",
					segmentId: "a1",
					messages: sideThreads[0]!.messages,
					answering: false,
					streamText: "",
					mode: "popover",
					anchor: { kind: "composer" },
				},
				onAsk: async () => true,
				onStop: () => {},
				onExpand: () => {},
				onFloat: () => {},
				onClose: () => {},
			}),
			["chain", "careful step", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Agent
	it("matches Agent subagent artifact cards across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "ss1",
				role: "custom",
				customType: "subagent-steer",
				content: "raw steer",
				display: true,
				details: {
					kind: "research",
					result: {
						brief: "Summary of **Fourier** series and *orthogonal basis* with über-clear convergence.",
						sources: [{ title: "Fourier analysis notes", url: "https://example.com/fourier" }],
					},
				},
				timestamp: 90,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Agent");
		const viewMsg = view.find((m) => m.parts.some((p) => p.type === "data-subagent-artifact"));
		assert.ok(unit && viewMsg);
		assertParity(
			unit,
			createElement("div", { "data-find-part": unit.key }, createElement(SubagentSteerCard, { message: viewMsg })),
			["Fourier", "orthogonal basis", "uber"],
		);
	});

	// plan 003 part 6: parity between findUnits and rendered [data-find-part] for Unit
	it("matches Unit cut dividers across word, phrase, and umlaut queries", () => {
		const native: LhMessage[] = [
			{
				id: "lr1",
				role: "custom",
				customType: "lesson-record",
				content: "",
				display: false,
				details: {
					firstKeptMessageId: "u-next",
					finishedUnitIds: ["u1"],
					currentUnitId: "Vector spaces und Überblick",
					judgment: { learnerWide: "", commitments: "", nodes: {} },
					at: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 95,
			} as never,
			{ id: "u-next", role: "user", content: "Next unit", timestamp: 100 } as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const unit = units.find((u) => u.kind === "Unit");
		const part = view.flatMap((m) => m.parts).find((p) => p.type === "data-unit-cut");
		assert.ok(unit && part);
		assertParity(
			unit,
			createElement(
				"div",
				{ "data-find-part": unit.key },
				createElement(UnitCutDivider, { data: part.data as UnitCutDividerData }),
			),
			["spaces", "Vector spaces", "Uberblick"],
		);
	});
});
