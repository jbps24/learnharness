import {
	CHECK_STEM_CLIP,
	EXPLAIN_ANSWER_CLIP,
	LESSON_RECORD_CAPS,
	LESSON_RECORD_HEADER,
	type LessonJudgment,
	type NodeJudgment,
} from "./contracts/chat.ts";
import { derivePlanStatusesLh, type PlanTree } from "./contracts/plan.ts";
import { probeDoneResultIds, type LhMessage } from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation } from "./plugin-questions.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { parseProbeDoneInput } from "./tool-parts.ts";

export interface LessonRecordPromptInput {
	taughtIds: readonly string[];
	facts: string;
	previous?: LessonJudgment | null;
	spanText: string;
}

export type ParseLessonJudgmentResult =
	| { ok: true; value: LessonJudgment }
	| { ok: false; problems: string[] };

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function outcomeOf(tool: "quiz" | "explain", d: QuestionAnswerData): string {
	if (d.dismissed === true) return "skipped";
	if (d.dontKnow === true) return "didn't know";
	if (tool === "quiz" && d.correct === true) return "right";
	if (tool === "quiz" && d.correct === false) {
		return `wrong (picked ${(d.answers ?? []).map((a) => `"${a.label}"`).join(", ")})`;
	}
	if (tool === "explain") {
		return `own words, ungraded: "${clip(String(d.text ?? "").replace(/\s+/g, " ").trim(), EXPLAIN_ANSWER_CLIP)}"`;
	}
	return "answered";
}

/** One line per answered built-in teach quiz/explain call that carries a nodeId, in transcript order. */
export function checkLines(messages: readonly LhMessage[]): Map<string, string[]> {
	const results = new Map<string, { isError?: boolean; details?: unknown }>();
	for (const m of messages) {
		if (m.role === "toolResult") results.set(m.toolCallId, m as { isError?: boolean; details?: unknown });
	}
	const lines = new Map<string, string[]>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const [i, block] of m.content.entries()) {
			if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			if (readPluginQuestionMessageAnnotation(m, i).status !== "absent") continue;
			const input = block.arguments as { nodeId?: unknown; type?: unknown } | undefined;
			if (typeof input?.nodeId !== "string") continue;
			const result = results.get(block.id);
			if (!result || result.isError || !result.details || typeof result.details !== "object") continue;
			const details = result.details as QuestionAnswerData;
			const role = input.type === "predict" || input.type === "check" ? input.type : "check";
			const stem = clip(String(details.questionText ?? "").replace(/\s+/g, " ").trim(), CHECK_STEM_CLIP);
			const list = lines.get(input.nodeId) ?? [];
			list.push(`${role} — "${stem}" — ${outcomeOf(block.name, details)}`);
			lines.set(input.nodeId, list);
		}
	}
	return lines;
}

function probeSection(messages: readonly LhMessage[]): string[] {
	const ok = probeDoneResultIds(messages);
	const first = messages.find((m) => m.role === "toolResult" && ok.has(m.id));
	if (!first || first.role !== "toolResult") return [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.id !== first.toolCallId) continue;
			const parsed = parseProbeDoneInput(block.arguments);
			if (!parsed) return [];
			const out = ["## Probe assessment"];
			for (const s of parsed.assessment.strands) out.push(`- ${s.strand}: ${s.assessment}`);
			if (parsed.assessment.summary) out.push(`Summary: ${parsed.assessment.summary}`);
			return out;
		}
	}
	return [];
}

/** The computed, authoritative progress facts of the record. */
export function recordFacts(
	tree: PlanTree,
	messages: readonly LhMessage[],
	finishedUnitIds: readonly string[],
	currentUnitId: string,
	judgmentNodeIds: readonly string[] = [],
): string {
	const checks = checkLines(messages);
	const statuses = derivePlanStatusesLh(tree, messages);
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	const nodeLines = (id: string): string[] => {
		const node = byId.get(id);
		if (!node) return [];
		const status = statuses.current === id ? "current" : statuses.visited.has(id) ? "visited" : "upcoming";
		return [`- [${status}] ${node.title} (${id})`, ...(checks.get(id) ?? []).map((l) => `    · ${l}`)];
	};

	const out: string[] = ["## Plan"];
	let currentUnitLabel = "";
	if (tree.units) {
		tree.units.forEach((u, i) => {
			const state = finishedUnitIds.includes(u.id) ? "finished" : u.id === currentUnitId ? "current" : "upcoming";
			if (u.id === currentUnitId) currentUnitLabel = `Unit ${i + 1} · ${u.title}`;
			out.push(`Unit ${i + 1} · ${u.title} (${state})${u.source ? ` — source: ${u.source}` : ""}`);
			for (const id of u.nodeIds) out.push(...nodeLines(id));
		});
	} else {
		for (const n of tree.nodes) out.push(...nodeLines(n.id));
	}
	if (tree.edges.length > 0) out.push(`Requires: ${tree.edges.map((e) => `${e.from} → ${e.to}`).join(", ")}`);

	const orphans = [...new Set([...checks.keys(), ...judgmentNodeIds])].filter((id) => !byId.has(id));
	if (orphans.length > 0) {
		out.push("## Taught, no longer in the plan");
		for (const id of orphans) out.push(`- (${id})`, ...(checks.get(id) ?? []).map((l) => `    · ${l}`));
	}

	out.push(...probeSection(messages));

	out.push("## Current position");
	out.push(`Current unit: ${currentUnitLabel}`);
	const current = statuses.current ? byId.get(statuses.current) : undefined;
	if (current) out.push(`current node: ${current.title} (${current.id})`);
	return out.join("\n");
}

const PROMPT_HEAD = `You are writing the judgment part of a lesson record: the notes your future self will teach from INSTEAD of the transcript below, which is being cut away. Progress facts (plan, statuses, check outcomes) are computed separately and are not your job — never state what was taught or how far the lesson got.

Write about the learner, from the transcript only. Every claim must be traceable to what the learner said or answered.

Return ONE JSON object and nothing else:
{"learnerWide": string, "commitments": string, "nodes": [{"nodeId": string, "learned": string, "errorsCorrected": string, "openPoints": string}]}
`;

export function buildLessonRecordPrompt(input: LessonRecordPromptInput): string {
	const { learned, errorsCorrected, openPoints, learnerWide, commitments } = LESSON_RECORD_CAPS;
	const ids = input.taughtIds.join(", ");
	const prev = input.previous;
	const previousNodes = input.taughtIds.flatMap((id) => {
		const n = prev?.nodes[id];
		return n
			? [`- ${id}: learned: ${n.learned} | errors corrected: ${n.errorsCorrected} | open points: ${n.openPoints}`]
			: [];
	});
	const previousText = prev
		? [
				`learnerWide: ${prev.learnerWide}`,
				`commitments: ${prev.commitments}`,
				...(previousNodes.length > 0 ? ["nodes:", ...previousNodes] : []),
			].join("\n")
		: "(none)";
	return [
		PROMPT_HEAD +
			`- nodes: exactly one entry for each of these node ids, which were taught in this stretch: ${ids}. No other ids. \`learned\` (≤${learned} chars, required): what the learner now understands and how they showed it. \`errorsCorrected\` (≤${errorsCorrected}, "" if none): misconceptions that surfaced and were corrected. \`openPoints\` (≤${openPoints}, "" if none): what is still shaky or unresolved. Where a previous entry exists (below), rewrite it to include what this stretch changed.\n` +
			`- learnerWide (≤${learnerWide.toLocaleString("en-US")} chars): only what shows across nodes — their stated or observed preferences (pace, formality, examples vs derivations), recurring misconceptions or reasoning habits, how their goal has evolved. Do not restate the probe assessment. Rewrite the previous text (below) to include this stretch.\n` +
			`- commitments (≤${commitments} chars, "" if none): promises the tutor made that are still owed (e.g. "come back to the Bode plot after unit 3"), each naming its node id when it has one. Keep earlier commitments still owed; drop those fulfilled.`,
		`COMPUTED FACTS:\n${input.facts}`,
		`PREVIOUS JUDGMENT:\n${previousText}`,
		`TRANSCRIPT:\n${input.spanText}`,
	].join("\n\n");
}

function stripFence(text: string): string {
	const m = /^\s*```(?:json)?[ \t]*\n?([\s\S]*?)\n?```\s*$/.exec(text);
	return (m ? m[1]! : text).trim();
}

export function parseLessonJudgment(text: string, taughtIds: readonly string[]): ParseLessonJudgmentResult {
	let raw: unknown;
	try {
		raw = JSON.parse(stripFence(text));
	} catch (error) {
		return { ok: false, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, problems: ["the top level must be a JSON object"] };
	}
	const obj = raw as Record<string, unknown>;
	const problems: string[] = [];
	const checkCap = (label: string, value: string, cap: number) => {
		if (value.length > cap) problems.push(`${label} is ${value.length} characters; the limit is ${cap}`);
	};

	let learnerWide = "";
	if (typeof obj.learnerWide !== "string") problems.push("learnerWide must be a string");
	else {
		learnerWide = obj.learnerWide.trim();
		checkCap("learnerWide", learnerWide, LESSON_RECORD_CAPS.learnerWide);
	}
	let commitments = "";
	if (typeof obj.commitments !== "string") problems.push("commitments must be a string");
	else {
		commitments = obj.commitments.trim();
		checkCap("commitments", commitments, LESSON_RECORD_CAPS.commitments);
	}

	const nodes: Record<string, NodeJudgment> = {};
	if (!Array.isArray(obj.nodes)) problems.push("nodes must be an array");
	else {
		const taught = new Set(taughtIds);
		const seen = new Set<string>();
		for (const entry of obj.nodes as unknown[]) {
			if (!entry || typeof entry !== "object" || typeof (entry as { nodeId?: unknown }).nodeId !== "string") {
				problems.push("each node entry must be an object with a string nodeId");
				continue;
			}
			const e = entry as Record<string, unknown>;
			const id = e.nodeId as string;
			if (seen.has(id)) {
				problems.push(`node "${id}" appears twice`);
				continue;
			}
			seen.add(id);
			if (!taught.has(id)) problems.push(`node "${id}" was not taught in this stretch`);
			const fields = {} as Record<"learned" | "errorsCorrected" | "openPoints", string>;
			for (const f of ["learned", "errorsCorrected", "openPoints"] as const) {
				if (typeof e[f] !== "string") {
					problems.push(`${f} of "${id}" must be a string`);
					continue;
				}
				fields[f] = (e[f] as string).trim();
				checkCap(`${f} of "${id}"`, fields[f], LESSON_RECORD_CAPS[f]);
			}
			if (typeof e.learned === "string" && fields.learned === "") problems.push(`learned of "${id}" is empty`);
			nodes[id] = { learned: fields.learned ?? "", errorsCorrected: fields.errorsCorrected ?? "", openPoints: fields.openPoints ?? "" };
		}
		for (const id of taught) if (!seen.has(id)) problems.push(`missing entry for node "${id}"`);
	}

	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { learnerWide, commitments, nodes } };
}

export function mergeJudgment(previous: LessonJudgment | null | undefined, parsed: LessonJudgment): LessonJudgment {
	return {
		learnerWide: parsed.learnerWide,
		commitments: parsed.commitments,
		nodes: { ...(previous?.nodes ?? {}), ...parsed.nodes },
	};
}

const QUESTION_LINE = /^ {4}· ([^ ]+) — "(.*)" — (.*)$/;
const PLAN_STRUCTURAL_PREFIXES = ["- [", "- (", "Unit ", "Requires:", "## "];
const EXPLAIN_RESULT_OPEN = 'own words, ungraded: "';

/**
 * Condense the per-question lines under each plan node into a counts line and
 * the newest question not answered right. Only the "## Plan" section changes;
 * idempotent (the condensed lines are not question lines).
 */
export function condenseLessonRecordPlan(text: string): string {
	const out: string[] = [];
	let inPlan = false;
	let asked: { type: string; text: string; result: string }[] = [];
	const flush = () => {
		if (asked.length === 0) return;
		const items = asked.map((q) => ({ ...q, category: q.result.replace(/ \(.*\)$/, "") }));
		const counts = new Map<string, number>();
		for (const q of items) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
		out.push(`    · ${items.length} asked: ${[...counts].map(([category, n]) => `${n} ${category}`).join(", ")}`);
		const gap = items.findLast((q) => q.category !== "right");
		if (gap) out.push(`    · newest gap: ${gap.type} — "${gap.text}" — ${gap.result}`);
		asked = [];
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			inPlan = line === "## Plan";
			out.push(line);
			continue;
		}
		const m = inPlan ? QUESTION_LINE.exec(line) : null;
		if (m) {
			asked.push({ type: m[1]!, text: m[2]!, result: m[3]! });
			continue;
		}
		if (inPlan && asked.length > 0 && !PLAN_STRUCTURAL_PREFIXES.some((p) => line.startsWith(p))) {
			const last = asked[asked.length - 1]!;
			const trimmed = line.trim();
			if (trimmed !== "") {
				last.result =
					last.result === "" || last.result === EXPLAIN_RESULT_OPEN
						? `${last.result}${trimmed}`
						: `${last.result} ${trimmed}`;
				continue;
			}
			const isUnclosedExplain =
				last.result.startsWith(EXPLAIN_RESULT_OPEN) &&
				(last.result.length === EXPLAIN_RESULT_OPEN.length || !last.result.endsWith('"'));
			if (isUnclosedExplain) continue;
		}
		flush();
		out.push(line);
	}
	flush();
	return out.join("\n");
}

/** The marker content: header, the computed facts verbatim, then the judgment. */
export function renderLessonRecord(facts: string, judgment: LessonJudgment): string {
	// Plan order and titles are read back from the facts' node lines.
	const titles = new Map<string, string>();
	const planOrder: string[] = [];
	for (const line of facts.split("\n")) {
		const m = /^- \[[a-z]+\] (.*) \(([^()]+)\)$/.exec(line);
		if (!m) continue;
		titles.set(m[2]!, m[1]!);
		planOrder.push(m[2]!);
	}
	const ordered = [
		...planOrder.filter((id) => judgment.nodes[id]),
		...Object.keys(judgment.nodes).filter((id) => !titles.has(id)),
	];
	const out = [LESSON_RECORD_HEADER, "", condenseLessonRecordPlan(facts), "## The learner, per node"];
	for (const id of ordered) {
		const n = judgment.nodes[id]!;
		const title = titles.get(id);
		out.push(`### ${title ? `${title} (${id})` : `(${id})`}`, `Learned: ${n.learned}`);
		if (n.errorsCorrected) out.push(`Errors corrected: ${n.errorsCorrected}`);
		if (n.openPoints) out.push(`Open points: ${n.openPoints}`);
	}
	out.push("## Across the lesson", judgment.learnerWide, "## Commitments still owed", judgment.commitments || "none");
	return out.join("\n");
}
