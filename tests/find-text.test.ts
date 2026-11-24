import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHits, findUnits, shownText, type FindUnit } from "../src/core/find-text.ts";
import { latestPlanUnits, projectView } from "../src/core/view.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const userMsg = (id: string, text: string, timestamp = 100): LhMessage =>
	({ id, role: "user", content: text, timestamp }) as never;

const assistantTextMsg = (id: string, text: string, timestamp = 200): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp }) as never;

describe("shownText", () => {
	// plan 003 part 4: empty or whitespace-only markdown produces no blocks
	it("returns empty array for empty or whitespace-only markdown", () => {
		assert.deepEqual(shownText(""), []);
		assert.deepEqual(shownText("   \n\n  "), []);
	});

	// plan 003 part 4: blocks are paragraph, heading, list item, table cell, blockquote paragraph, code block; phrase never spans two blocks
	it("splits paragraph, heading, list item, table cell, blockquote paragraph, and code block into separate blocks", () => {
		const md = [
			"# Heading title",
			"",
			"First paragraph.",
			"",
			"- Item one",
			"- Item two",
			"",
			"> Quote alpha",
			">",
			"> Quote beta",
			"",
			"| Col A | Col B |",
			"| --- | --- |",
			"| Cell 1 | Cell 2 |",
			"",
			"```ts",
			"const answer = 42;",
			"```",
		].join("\n");

		const blocks = shownText(md);
		assert.ok(blocks.includes("Heading title"));
		assert.ok(blocks.includes("First paragraph."));
		assert.ok(blocks.includes("Item one"));
		assert.ok(blocks.includes("Item two"));
		assert.ok(blocks.includes("Quote alpha"));
		assert.ok(blocks.includes("Quote beta"));
		assert.ok(blocks.includes("Col A"));
		assert.ok(blocks.includes("Col B"));
		assert.ok(blocks.includes("Cell 1"));
		assert.ok(blocks.includes("Cell 2"));
		assert.ok(blocks.includes("const answer = 42;"));
		assert.equal(blocks.some((b) => b.includes("Heading title") && b.includes("First paragraph.")), false);
	});

	// plan 003 part 4: drop math, inlineMath, html, images, and diagram fenced code (mermaid)
	it("drops math, inlineMath, html, images, and mermaid code fences", () => {
		const md = [
			"Visible prose with $inlineFormula$ here.",
			"",
			"$$",
			"\\int_0^1 x^2 dx",
			"$$",
			"",
			"<div>rawHtmlHidden</div>",
			"",
			"![altTextHidden](https://example.com/image.png)",
			"",
			"```mermaid",
			"graph TD",
			"MermaidNodeA-->MermaidNodeB",
			"```",
		].join("\n");

		const joined = shownText(md).join("\n");
		assert.ok(joined.includes("Visible prose"));
		assert.equal(joined.includes("inlineFormula"), false);
		assert.equal(joined.includes("\\int_0^1"), false);
		assert.equal(joined.includes("rawHtmlHidden"), false);
		assert.equal(joined.includes("altTextHidden"), false);
		assert.equal(joined.includes("example.com/image.png"), false);
		assert.equal(joined.includes("MermaidNodeA"), false);
	});

	// plan 003 part 4: keep link text (not URL), inline code text, and other code blocks' text
	it("keeps link text without URL, inline code, and non-diagram code blocks", () => {
		const md = [
			"Read [the guide](https://example.com/secret-url) and run `computeSum()`.",
			"",
			"```python",
			"def compute_sum(): return 1",
			"```",
		].join("\n");

		const joined = shownText(md).join("\n");
		assert.ok(joined.includes("the guide"));
		assert.ok(joined.includes("computeSum()"));
		assert.ok(joined.includes("def compute_sum(): return 1"));
		assert.equal(joined.includes("https://example.com/secret-url"), false);
	});
});

describe("latestPlanUnits", () => {
	// plan 003 part 4: latestPlanUnits exported from src/core/view.ts
	it("returns the newest plan tool result units or undefined when absent", () => {
		assert.equal(latestPlanUnits([]), undefined);
		const msgs: LhMessage[] = [
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "c1",
				toolName: "plan_init",
				content: [],
				isError: false,
				details: { ok: true, tree: { nodes: [], edges: [], units: [{ id: "u1", title: "Old", nodeIds: [] }], version: 1 } },
				timestamp: 1,
			} as never,
			{
				id: "r2",
				role: "toolResult",
				toolCallId: "c2",
				toolName: "plan_update",
				content: [],
				isError: false,
				details: { ok: true, tree: { nodes: [], edges: [], units: [{ id: "u1", title: "New", nodeIds: [] }], version: 2 } },
				timestamp: 2,
			} as never,
		];
		assert.deepEqual(latestPlanUnits(msgs), [{ id: "u1", title: "New", nodeIds: [] }]);
	});
});

describe("findUnits", () => {
	// plan 003 part 4: You units extract user text and practice-thinking as plain text (no markdown parsing, collapsed whitespace, one block per line break)
	it("extracts You units for user messages and practice-thinking as plain text", () => {
		const native: LhMessage[] = [
			userMsg("u1", "Hello   **world**\nSecond   line", 10),
			{
				id: "pt1",
				role: "custom",
				customType: "practice-thinking",
				content: "Your thinking: trace",
				display: true,
				details: { problemCallId: "p1", text: "My   thinking\nLine two" },
				timestamp: 20,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const youUnits = units.filter((u) => u.kind === "You");
		assert.equal(youUnits.length, 2);
		assert.equal(youUnits[0]!.sourceMessageId, "u1");
		assert.deepEqual(youUnits[0]!.blocks, ["Hello **world**", "Second line"]);
		assert.equal(youUnits[1]!.sourceMessageId, "pt1");
		assert.deepEqual(youUnits[1]!.blocks, ["My thinking", "Line two"]);
	});

	// plan 003 part 4: Teacher units extract assistant text parts and send_to_user prose through shownText
	it("extracts Teacher units for assistant text and send_to_user prose via shownText", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "text", text: "Intro [link](https://secret.test) $x$" },
					{ type: "toolCall", id: "stu1", name: "send_to_user", arguments: { text: "Next **step**" } },
				],
				timestamp: 30,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		const teacherText = units.filter((u) => u.kind === "Teacher").flatMap((u) => u.blocks).join("\n");
		assert.ok(teacherText.includes("Intro link"));
		assert.ok(teacherText.includes("Next step"));
		assert.equal(teacherText.includes("secret.test"), false);
	});

	// plan 003 part 4: Check/Question answered cards; dismissed extracts questionText only
	it("extracts Check and Question fields and restricts dismissed cards to questionText", () => {
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
							question: "Quiz stem",
							details: "Quiz details",
							options: [{ label: "Opt 1", value: "o1" }, { label: "Opt 2", value: "o2" }],
							correctAnswer: "o1",
							explanation: "Why opt 1",
						},
					},
					{
						type: "toolCall",
						id: "q2",
						name: "ask",
						arguments: {
							question: "Ask stem",
							details: "Ask details",
							options: [
								{ label: "Choice A", value: "a", description: "Desc A" },
								{ label: "Choice B", value: "b" },
							],
						},
					},
					{
						type: "toolCall",
						id: "q3",
						name: "quiz",
						arguments: {
							question: "Dismissed stem",
							options: [{ label: "X", value: "x" }, { label: "Y", value: "y" }],
							correctAnswer: "x",
							explanation: "Hidden dismissed explanation",
						},
					},
				],
				timestamp: 10,
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
					questionText: "Quiz stem",
					dontKnow: false,
					answers: [{ index: 1, label: "Opt 1", value: "o1" }],
					options: [{ index: 1, label: "Opt 1" }, { index: 2, label: "Opt 2" }],
					readingThinking: "Reading thought",
					thinking: "Answer thought",
					explanation: "Why opt 1",
					answeredAt: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 20,
			} as never,
			{
				id: "r2",
				role: "toolResult",
				toolCallId: "q2",
				toolName: "ask",
				content: [],
				isError: false,
				details: {
					kind: "ask",
					questionText: "Ask stem",
					dontKnow: false,
					answers: [],
					options: [
						{ index: 1, label: "Choice A" },
						{ index: 2, label: "Choice B" },
					],
					other: "Custom other",
					answeredAt: "2026-11-22T00:00:01.000Z",
				},
				timestamp: 30,
			} as never,
			{
				id: "r3",
				role: "toolResult",
				toolCallId: "q3",
				toolName: "quiz",
				content: [],
				isError: false,
				details: {
					kind: "quiz",
					questionText: "Dismissed stem",
					dismissed: true,
					dontKnow: false,
					answers: [],
					answeredAt: "2026-11-22T00:00:02.000Z",
				},
				timestamp: 40,
			} as never,
		];
		const view = projectView(native);
		const units = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });

		const checks = units.filter((u) => u.kind === "Check");
		const quizCheck = checks.find((u) => u.blocks.includes("Quiz stem"));
		assert.ok(quizCheck);
		const quizText = quizCheck.blocks.join("\n");
		assert.ok(quizText.includes("Quiz details"));
		assert.ok(quizText.includes("Opt 1"));
		assert.ok(quizText.includes("Reading thought"));
		assert.ok(quizText.includes("Answer thought"));
		assert.ok(quizText.includes("Why opt 1"));

		const dismissedCheck = checks.find((u) => u.blocks.includes("Dismissed stem"));
		assert.ok(dismissedCheck);
		assert.deepEqual(dismissedCheck.blocks, ["Dismissed stem"]);

		const askUnit = units.find((u) => u.kind === "Question");
		assert.ok(askUnit);
		const askText = askUnit.blocks.join("\n");
		assert.ok(askText.includes("Ask stem"));
		assert.ok(askText.includes("Ask details"));
		assert.ok(askText.includes("Choice A"));
		assert.ok(askText.includes("Desc A"));
		assert.ok(askText.includes("Custom other"));
	});

	// plan 003 part 4: pending question in the dock (key "dock") only when pendingQuestionVisible; never leaks unrevealed explanation
	it("includes pending dock question only when pendingQuestionVisible is true and omits explanation", () => {
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
							question: "Pending dock stem",
							details: "Pending details",
							options: [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }],
							correctAnswer: "a",
							explanation: "Unrevealed secret explanation",
						},
					},
				],
				timestamp: 50,
			} as never,
		];
		const view = projectView(native);

		const hidden = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: false });
		assert.equal(hidden.some((u) => u.key === "dock"), false);
		assert.equal(hidden.flatMap((u) => u.blocks).join("\n").includes("Pending dock stem"), false);

		const visible = findUnits({ native, view, sideThreads: [], pendingQuestionVisible: true });
		const dockUnit = visible.find((u) => u.key === "dock");
		assert.ok(dockUnit);
		const dockText = dockUnit.blocks.join("\n");
		assert.ok(dockText.includes("Pending dock stem"));
		assert.ok(dockText.includes("Pending details"));
		assert.ok(dockText.includes("Alpha"));
		assert.equal(dockText.includes("Unrevealed secret explanation"), false);
	});

	// plan 003 part 4: Problem never exposes modelSolution before conclude; Solution extracts verdict and modelSolution
	it("omits modelSolution from Problem before conclude and includes it in Solution after conclude", () => {
		const poseOnly: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "p1",
						name: "problem",
						arguments: { statement: "Solve x + 1 = 2", mode: "recall", modelSolution: "Subtract 1 to get x = 1" },
					},
				],
				timestamp: 10,
			} as never,
			{ id: "r_p1", role: "toolResult", toolCallId: "p1", toolName: "problem", content: [], isError: false, details: {}, timestamp: 15 } as never,
		];
		const poseUnits = findUnits({ native: poseOnly, view: projectView(poseOnly), sideThreads: [], pendingQuestionVisible: false });
		const problemUnit = poseUnits.find((u) => u.kind === "Problem");
		assert.ok(problemUnit);
		assert.ok(problemUnit.blocks.join("\n").includes("Solve x + 1 = 2"));
		assert.equal(poseUnits.flatMap((u) => u.blocks).join("\n").includes("Subtract 1 to get x = 1"), false);
		assert.equal(poseUnits.some((u) => u.kind === "Solution"), false);

		const withConclude: LhMessage[] = [
			...poseOnly,
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "conclude",
						arguments: { outcome: "solved", verdict: "Clean algebraic step", feedback: "Watch the sign next time" },
					},
				],
				timestamp: 20,
			} as never,
		];
		const concludedUnits = findUnits({ native: withConclude, view: projectView(withConclude), sideThreads: [], pendingQuestionVisible: false });
		const solutionUnit = concludedUnits.find((u) => u.kind === "Solution");
		assert.ok(solutionUnit);
		const solText = solutionUnit.blocks.join("\n");
		assert.ok(solText.includes("Clean algebraic step"));
		assert.ok(solText.includes("Watch the sign next time"));
		assert.ok(solText.includes("Subtract 1 to get x = 1"));
	});

	it("does not extract modelSolution into Solution when the pose is unacked or refused", () => {
		const unacked: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "p1",
						name: "problem",
						arguments: { statement: "Solve x + 2 = 5", mode: "recall", modelSolution: "Secret unacked solution" },
					},
				],
				timestamp: 10,
			} as never,
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "conclude",
						arguments: { outcome: "solved", verdict: "Unacked verdict", feedback: "Unacked feedback" },
					},
				],
				timestamp: 20,
			} as never,
		];
		const unackedSolution = findUnits({ native: unacked, view: projectView(unacked), sideThreads: [], pendingQuestionVisible: false }).find((u) => u.kind === "Solution");
		assert.ok(unackedSolution);
		const unackedText = unackedSolution.blocks.join("\n");
		assert.ok(unackedText.includes("Unacked verdict"));
		assert.ok(unackedText.includes("Unacked feedback"));
		assert.equal(unackedText.includes("Secret unacked solution"), false);

		const refused: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "p2",
						name: "problem",
						arguments: { statement: "Solve x + 3 = 7", mode: "recall", modelSolution: "Secret refused solution" },
					},
				],
				timestamp: 10,
			} as never,
			{ id: "r_p2", role: "toolResult", toolCallId: "p2", toolName: "problem", content: [], isError: true, details: {}, timestamp: 15 } as never,
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c2",
						name: "conclude",
						arguments: { outcome: "solved", verdict: "Refused verdict", feedback: "Refused feedback" },
					},
				],
				timestamp: 20,
			} as never,
		];
		const refusedSolution = findUnits({ native: refused, view: projectView(refused), sideThreads: [], pendingQuestionVisible: false }).find((u) => u.kind === "Solution");
		assert.ok(refusedSolution);
		const refusedText = refusedSolution.blocks.join("\n");
		assert.ok(refusedText.includes("Refused verdict"));
		assert.ok(refusedText.includes("Refused feedback"));
		assert.equal(refusedText.includes("Secret refused solution"), false);
	});

	// plan 003 part 4: Plan units extract plan-block node titles and shown descriptions
	it("extracts Plan units from plan-block parts", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "pi1", name: "plan_init", arguments: {} }],
				timestamp: 10,
			} as never,
			{
				id: "pr1",
				role: "toolResult",
				toolCallId: "pi1",
				toolName: "plan_init",
				content: [],
				isError: false,
				details: { ok: true, tree: { nodes: [{ id: "n1", title: "Chain Rule", status: "current" }], edges: [], version: 1 } },
				timestamp: 11,
			} as never,
			{
				id: "pb1",
				role: "custom",
				customType: "plan-block",
				content: "",
				display: true,
				details: {
					planCallId: "pi1",
					block: { kind: "full", at: "2026-11-22T00:00:00.000Z", current: "n1", nodes: [{ id: "n1", title: "Chain Rule", summary: "Differentiate nested functions", status: "current" }], edges: [] },
				},
				timestamp: 12,
			} as never,
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const planUnit = units.find((u) => u.kind === "Plan");
		assert.ok(planUnit);
		assert.ok(planUnit.blocks.join("\n").includes("Chain Rule"));
		assert.ok(planUnit.blocks.join("\n").includes("Differentiate nested functions"));
	});

	// plan 003 part 4: Agent units extract sub-agent artifact cards
	it("extracts Agent units from subagent-steer artifact cards", () => {
		const native: LhMessage[] = [
			{
				id: "ss1",
				role: "custom",
				customType: "subagent-steer",
				content: "raw steer",
				display: true,
				details: {
					kind: "pdf",
					result: { path: "/doc.pdf", question: "q", brief: "Key PDF **finding**", pagesRead: [1], pagesConsulted: [1] },
				},
				timestamp: 15,
			} as never,
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const agentUnit = units.find((u) => u.kind === "Agent");
		assert.ok(agentUnit);
		assert.ok(agentUnit.blocks.join("\n").includes("Key PDF finding"));
	});

	// plan 003 part 4: Side chat entries ordered by own time, anchored to anchor.messageId
	it("extracts Side chat units with anchor sourceMessageId, thread/message ids, and own timestamps", () => {
		const native: LhMessage[] = [assistantTextMsg("a1", "Main explanation", 1000)];
		const sideThreads: SideChatThread[] = [
			{
				id: "st1",
				anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "Main explanation" },
				open: false,
				createdAt: "2026-11-22T10:00:00.000Z",
				messages: [
					{ id: "sm1", role: "user", text: "Side question?", at: "2026-11-22T10:00:05.000Z" },
					{ id: "sm2", role: "assistant", text: "Side **answer** $z$", at: "2026-11-22T10:00:10.000Z" },
				],
			},
		];
		const units = findUnits({ native, view: projectView(native), sideThreads, pendingQuestionVisible: false });
		const sideUnits = units.filter((u) => u.kind === "Side chat");
		assert.equal(sideUnits.length, 2);
		assert.equal(sideUnits[0]!.sourceMessageId, "a1");
		assert.equal(sideUnits[0]!.sideThreadId, "st1");
		assert.equal(sideUnits[0]!.sideMessageId, "sm1");
		assert.equal(sideUnits[0]!.time, Date.parse("2026-11-22T10:00:05.000Z"));
		assert.equal(sideUnits[1]!.sideMessageId, "sm2");
		assert.equal(sideUnits[1]!.time, Date.parse("2026-11-22T10:00:10.000Z"));
		assert.ok(sideUnits[1]!.blocks.join("\n").includes("Side answer"));
		assert.equal(sideUnits[1]!.blocks.join("\n").includes("$z$"), false);
	});

	// plan 003 part 4: Unit dividers ("Unit N · title") and unit labels across a unit cut; null when plan has no units
	it("extracts Unit dividers and assigns unit labels across a lesson-record cut", () => {
		const native: LhMessage[] = [
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
						nodes: [],
						edges: [],
						units: [
							{ id: "u1", title: "Limits", nodeIds: [] },
							{ id: "u2", title: "Derivatives", nodeIds: [] },
						],
						version: 1,
					},
				},
				timestamp: 1,
			} as never,
			userMsg("m1", "Before cut", 2),
			{
				id: "lr1",
				role: "custom",
				customType: "lesson-record",
				content: "",
				display: false,
				details: { currentUnitId: "u2", finishedUnitIds: ["u1"], firstKeptMessageId: "m2" },
				timestamp: 3,
			} as never,
			userMsg("m2", "After cut", 4),
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const before = units.find((u) => u.sourceMessageId === "m1" && u.kind === "You");
		const unitDiv = units.find((u) => u.kind === "Unit");
		const after = units.find((u) => u.sourceMessageId === "m2" && u.kind === "You");

		assert.ok(before);
		assert.ok(unitDiv);
		assert.deepEqual(unitDiv.blocks, ["Unit 2 · Derivatives"]);
		assert.ok(after);
		assert.deepEqual(after.unit, { index: 2, title: "Derivatives" });
	});

	// plan 003 part 4: unit is null when the plan has no units
	it("labels units null when the plan has no units", () => {
		const native: LhMessage[] = [userMsg("m1", "No plan here", 2), assistantTextMsg("a1", "Teacher words", 3)];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		assert.ok(units.length >= 2);
		for (const u of units) assert.equal(u.unit, null);
	});

	// plan 003 part 4: Check fields text, `thinking ?? note`, committed
	it("extracts text, the note fallback and committed from answered cards", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "q1", name: "ask", arguments: { question: "Free stem" } }],
				timestamp: 10,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "ask",
				content: [],
				isError: false,
				details: {
					kind: "ask",
					questionText: "Free stem",
					dontKnow: false,
					answers: [],
					text: "Typed free answer",
					note: "Fallback note text",
					committed: "Committed answer text",
					answeredAt: "2026-11-22T00:00:00.000Z",
				},
				timestamp: 20,
			} as never,
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const text = units.filter((u) => u.kind === "Question" || u.kind === "Check").flatMap((u) => u.blocks).join("\n");
		assert.ok(text.includes("Typed free answer"));
		assert.ok(text.includes("Fallback note text"));
		assert.ok(text.includes("Committed answer text"));
	});

	// plan 003 part 4: excluded parts (reasoning, compaction, lesson records, phase/break dividers)
	it("excludes reasoning parts, compaction summaries, lesson records, and break dividers", () => {
		const native: LhMessage[] = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Secret model reasoning" },
					{ type: "text", text: "Visible teacher text" },
				],
				timestamp: 10,
			} as never,
			{
				id: "cm1",
				role: "custom",
				customType: "compaction",
				content: "Compaction summary text",
				display: true,
				details: { firstKeptMessageId: "a1" },
				timestamp: 20,
			} as never,
			{
				id: "br1",
				role: "toolResult",
				toolCallId: "b1",
				toolName: "suggest_break",
				content: [],
				isError: false,
				details: { ok: true },
				timestamp: 30,
			} as never,
		];
		const units = findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: false });
		const allText = units.flatMap((u) => u.blocks).join("\n");
		assert.ok(allText.includes("Visible teacher text"));
		assert.equal(allText.includes("Secret model reasoning"), false);
		assert.equal(allText.includes("Compaction summary text"), false);
	});
});

describe("findHits", () => {
	// plan 003 part 4: newest first by time, ties by order descending, within a unit by position descending; occurrence 0-based in unit
	it("orders hits newest first by time, then order descending, then position descending with 0-based occurrence", () => {
		const units: FindUnit[] = [
			{ key: "k1", sourceMessageId: "m1", kind: "You", unit: null, time: 100, order: 1, blocks: ["hit one", "hit two and hit three"] },
			{ key: "k2", sourceMessageId: "m2", kind: "Teacher", unit: null, time: 100, order: 2, blocks: ["hit tied-time newer order"] },
			{ key: "k3", sourceMessageId: "m3", kind: "Side chat", unit: null, time: 200, order: 0, blocks: ["hit newest time"] },
		];
		const hits = findHits(units, "hit");
		assert.equal(hits.length, 5);
		assert.equal(hits[0]!.unitKey, "k3");
		assert.equal(hits[1]!.unitKey, "k2");
		// k1 has 3 hits: block 1 second hit (occ 2), block 1 first hit (occ 1), block 0 hit (occ 0)
		assert.deepEqual(
			hits.slice(2).map((h) => ({ unitKey: h.unitKey, block: h.block, occurrence: h.occurrence })),
			[
				{ unitKey: "k1", block: 1, occurrence: 2 },
				{ unitKey: "k1", block: 1, occurrence: 1 },
				{ unitKey: "k1", block: 0, occurrence: 0 },
			],
		);
	});

	// plan 003 part 4: a phrase never spans two blocks
	it("does not match a phrase across two adjacent blocks", () => {
		const unit: FindUnit = { key: "k", sourceMessageId: "m", kind: "Teacher", unit: null, time: 1, order: 0, blocks: ["first part", "second part"] };
		assert.deepEqual(findHits([unit], "part second"), []);
		assert.equal(findHits([unit], "second part").length, 1);
	});

	// plan 003 part 4: snippets take up to 60 chars before and 90 after, collapsed whitespace, with … where cut
	it("formats snippets with up to 60 before / 90 after, collapsed whitespace, and ellipsis only where cut", () => {
		const shortUnit: FindUnit = {
			key: "short",
			sourceMessageId: "m1",
			kind: "You",
			unit: null,
			time: 10,
			order: 0,
			blocks: ["alpha   target   omega"],
		};
		const shortHits = findHits([shortUnit], "target");
		assert.equal(shortHits.length, 1);
		assert.deepEqual(shortHits[0]!.snippet, {
			before: "alpha ",
			match: "target",
			after: " omega",
		});

		const longBefore = `${"a".repeat(80)}   `;
		const longAfter = `   ${"b".repeat(120)}`;
		const longUnit: FindUnit = {
			key: "long",
			sourceMessageId: "m2",
			kind: "Teacher",
			unit: null,
			time: 20,
			order: 1,
			blocks: [`${longBefore}target${longAfter}`],
		};
		const longHits = findHits([longUnit], "target");
		assert.equal(longHits.length, 1);
		const { before, match, after } = longHits[0]!.snippet;
		assert.equal(match, "target");
		assert.ok(before.startsWith("…"));
		assert.ok(before.length <= 61);
		assert.ok(!/\s{2,}/.test(before));
		assert.ok(after.endsWith("…"));
		assert.ok(after.length <= 91);
		assert.ok(!/\s{2,}/.test(after));
		assert.equal(after, ` ${"b".repeat(89)}…`);
	});

	it("labels the pending dock question Check for a quiz and Question for ask_user_question", () => {
		const pendingOf = (name: string): LhMessage[] => [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "q1", name, arguments: { question: "Dock stem", options: [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }], correctAnswer: "a", explanation: "Why" } }],
				timestamp: 50,
			} as never,
		];
		const dockKind = (name: string) => {
			const native = pendingOf(name);
			return findUnits({ native, view: projectView(native), sideThreads: [], pendingQuestionVisible: true }).find((u) => u.key === "dock")?.kind;
		};
		assert.equal(dockKind("quiz"), "Check");
		assert.equal(dockKind("ask_user_question"), "Question");
	});
});
