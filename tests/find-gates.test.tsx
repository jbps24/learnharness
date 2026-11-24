import React, { createElement } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ConcludeCard } from "../components/practice-cards.tsx";
import { findHits, findUnits } from "../src/core/find-text.ts";
import { PRACTICE_CONCLUDE_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

function concludeMarkup(input: Record<string, unknown>): string {
	return renderToStaticMarkup(
		createElement(
			InteractionLayersProvider,
			null,
			createElement(ConcludeCard, {
				part: {
					type: `tool-${PRACTICE_CONCLUDE_TOOL}`,
					state: "output-available",
					toolCallId: "c1",
					input,
					reveal: "",
					problemInput: {},
				},
			}),
		),
	);
}

describe("conclude card metadata gate", () => {
	for (const [name, extra] of [
		["rung", { rung: "recall" }],
		["miss class", { missClass: "slip" }],
		["retest", { retest: true }],
	] as const) {
		it(`mounts the Metadata trigger when only ${name} is set`, () => {
			assert.match(concludeMarkup({ outcome: "solved", verdict: "Fine.", ...extra }), /Metadata/);
		});
	}

	it("mounts no trigger when the conclude call carries no metadata", () => {
		assert.doesNotMatch(concludeMarkup({ outcome: "solved", verdict: "Fine." }), /Metadata/);
	});
});

describe("find units: ask-call fields stay on ask answers", () => {
	it("does not leak an ask-shaped input's details or option subtext onto a quiz answer", () => {
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
							question: "Pick one?",
							details: "LEAKDETAILS",
							options: [{ label: "Alpha", description: "LEAKSUB" }, { label: "Beta" }],
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
					questionText: "Pick one?",
					dontKnow: false,
					answers: [{ index: 1, label: "Alpha", value: "a" }],
					options: [
						{ index: 1, label: "Alpha" },
						{ index: 2, label: "Beta" },
					],
					correct: true,
					correctIndices: [1],
					answeredAt: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 31,
			} as never,
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		assert.ok(findHits(units, "Alpha").length > 0);
		assert.equal(findHits(units, "LEAKDETAILS").length, 0);
		assert.equal(findHits(units, "LEAKSUB").length, 0);
	});
});
