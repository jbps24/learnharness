/** Find text core (plan 003 part 4): the pure extractor from the stored
 *  messages to the searchable units of text, and the hits inside them. The
 *  page only places highlights; labels, order and text are decided here. */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { SideChatThread } from "./contracts/chat.ts";
import { findSessionTextMatches } from "./find-match.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, SEND_TO_USER_TOOL, pendingQuestionOf, type LhMessage } from "./native-messages.ts";
import { readPluginQuestionAnswer } from "./plugin-questions.ts";
import { readPluginProblemSubmission } from "./plugin-problems.ts";
import { parseAskInput, parseQuizInput } from "./tool-parts.ts";
import { latestPlanUnits, type LhViewMessage, type LhViewPart } from "./view.ts";

export interface FindInput {
	native: readonly LhMessage[];
	view: readonly LhViewMessage[];
	sideThreads: readonly SideChatThread[];
	/** The pending question in the dock is visible (not behind the reveal gate, or revealed). */
	pendingQuestionVisible: boolean;
}

export type FindUnitKind =
	| "You"
	| "Teacher"
	| "Check"
	| "Question"
	| "Problem"
	| "Solution"
	| "Plan"
	| "Side chat"
	| "Agent"
	| "Unit";

export interface FindUnit {
	/** Stable; equals the part's DOM `data-find-part`. */
	key: string;
	/** Native message to draw to; for side chats the anchor message. */
	sourceMessageId: string;
	kind: FindUnitKind;
	unit: { index: number; title: string } | null;
	/** The native message's timestamp; side-chat entries their own. */
	time: number;
	/** Transcript order, for ties. */
	order: number;
	sideThreadId?: string;
	sideMessageId?: string;
	blocks: string[];
}

export interface FindHit {
	unitKey: string;
	block: number;
	/** Nth match inside the unit, 0-based. */
	occurrence: number;
	snippet: {
		before: string;
		match: string;
		after: string;
	};
}

/** Fence languages the transcript renders as a diagram (components/md-blocks.tsx
 *  draws `mermaid` itself; plugin code blocks are not known to the core). */
const DIAGRAM_LANGUAGES: ReadonlySet<string> = new Set(["mermaid"]);

interface MdNode {
	type: string;
	value?: string;
	lang?: string | null;
	children?: MdNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** The text of a phrasing run: link text without the URL, inline code kept;
 *  images, inline math and raw html dropped. */
function inlineText(node: MdNode): string {
	switch (node.type) {
		case "text":
		case "inlineCode":
			return node.value ?? "";
		case "break":
			return " ";
		case "image":
		case "imageReference":
		case "inlineMath":
		case "html":
		case "footnoteReference":
			return "";
		default:
			return (node.children ?? []).map(inlineText).join("");
	}
}

function collectBlocks(node: MdNode, out: string[]): void {
	switch (node.type) {
		case "paragraph":
		case "heading":
		case "tableCell":
			out.push(inlineText(node));
			return;
		case "code":
			if (!DIAGRAM_LANGUAGES.has((node.lang ?? "").toLowerCase())) out.push(node.value ?? "");
			return;
		case "math":
		case "html":
		case "thematicBreak":
		case "definition":
		case "yaml":
			return;
		default:
			for (const child of node.children ?? []) collectBlocks(child, out);
	}
}

/** The text a markdown string shows, one string per block. */
export function shownText(markdown: string): string[] {
	if (markdown.trim() === "") return [];
	const out: string[] = [];
	collectBlocks(parser.parse(markdown) as unknown as MdNode, out);
	return out.filter((block) => block.trim() !== "");
}

/** Learner-authored text is plain: whitespace runs collapsed, one block per line. */
function plainText(text: string): string[] {
	return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const rec = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** An answered question card (components/answered-card.tsx): what it shows. */
function answeredBlocks(answer: Record<string, unknown>, input: unknown): string[] {
	const md = (value: unknown): string[] => shownText(str(value) ?? "");
	const plain = (value: unknown): string[] => plainText(str(value) ?? "");
	const blocks = md(answer.questionText);
	if (answer.dismissed === true) return blocks;
	// The card renders details and option subtext only from a call that parses for display.
	const askCall = answer.kind === "ask" ? parseAskInput(input) : undefined;
	blocks.push(...md(askCall?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined)));
	const callOptions: unknown[] = askCall?.options ?? [];
	const options = Array.isArray(answer.options) ? answer.options : [];
	for (const option of options) {
		const o = rec(option);
		blocks.push(...md(o?.label));
		// Ask-option subtext rides the call, by the option's 1-based index.
		if (answer.kind === "ask" && typeof o?.index === "number") blocks.push(...md(rec(callOptions[o.index - 1])?.description));
	}
	blocks.push(...plain(answer.other), ...plain(answer.text), ...plain(answer.readingThinking));
	blocks.push(...plain(answer.thinking ?? answer.note), ...md(answer.explanation), ...md(answer.committed));
	return blocks;
}

/** The pending question as the dock shows it: question, details, options. */
function dockBlocks(input: unknown): string[] {
	const call = rec(input);
	const blocks = [...shownText(str(call?.question) ?? ""), ...shownText(str(call?.details) ?? "")];
	for (const option of Array.isArray(call?.options) ? call.options : []) {
		const o = rec(option);
		blocks.push(...shownText(str(o?.label) ?? ""), ...shownText(str(o?.description) ?? ""));
	}
	return blocks;
}

/** The brief a sub-agent artifact card shows (research/pdf), by kind. */
function artifactBlocks(data: Record<string, unknown> | undefined): string[] {
	const result = rec(data?.result);
	if (!result) return [];
	const blocks = [...shownText(str(result.title) ?? ""), ...shownText(str(result.brief) ?? "")];
	for (const source of Array.isArray(result.sources) ? result.sources : []) blocks.push(...plainText(str(rec(source)?.title) ?? ""));
	return blocks;
}

export function findUnits(input: FindInput): FindUnit[] {
	const { native, view, sideThreads } = input;
	const planUnits = latestPlanUnits(native);
	const hasUnits = !!planUnits && planUnits.length > 0;

	// View parts by native source, and tool parts by (source, call id).
	const bySource = new Map<string, LhViewPart[]>();
	const toolParts = new Map<string, LhViewPart>();
	for (const message of view) {
		for (const part of message.parts) {
			if (!part.sourceMessageId) continue;
			const list = bySource.get(part.sourceMessageId) ?? [];
			list.push(part);
			bySource.set(part.sourceMessageId, list);
			if (part.type.startsWith("tool-") && part.toolCallId) toolParts.set(`${part.sourceMessageId}\0${part.toolCallId}`, part);
		}
	}
	const failedOutputs = new Set<string>();
	for (const m of native) {
		if (m.role === "toolResult" && m.toolName === SEND_TO_USER_TOOL && m.isError) failedOutputs.add(m.toolCallId);
	}

	const out: FindUnit[] = [];
	let unit: { index: number; title: string } | null = hasUnits ? { index: 1, title: planUnits![0]!.title } : null;
	let order = 0;
	const orderOf = new Map<string, number>();
	const unitOf = new Map<string, { index: number; title: string } | null>();
	const timeOf = new Map<string, number>();

	for (const m of native) {
		const time = typeof m.timestamp === "number" ? m.timestamp : 0;
		const parts = bySource.get(m.id) ?? [];
		const push = (key: string, kind: FindUnitKind, blocks: string[]): void => {
			if (blocks.length === 0) return;
			out.push({ key, sourceMessageId: m.id, kind, unit: unit && { ...unit }, time, order: order++, blocks });
		};

		for (const part of parts) {
			if (part.type !== "data-unit-cut") continue;
			const data = rec(part.data);
			const index = typeof data?.unitIndex === "number" ? data.unitIndex : 0;
			const title = str(data?.title) ?? "";
			unit = hasUnits ? { index, title } : null;
			push(part.id ?? `uc_${m.id}`, "Unit", [`Unit ${index} · ${title}`]);
		}
		orderOf.set(m.id, order);
		unitOf.set(m.id, unit && { ...unit });
		timeOf.set(m.id, time);

		if (m.role === "user") {
			const content = m.content as string | Array<{ type: string; text?: string }>;
			const text = typeof content === "string" ? content : content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
			push(`${m.id}:you`, "You", plainText(text));
			continue;
		}

		if (m.role === "custom") {
			for (const part of parts) {
				const key = part.id ?? `${m.id}:${part.type}`;
				const data = rec(part.data);
				switch (part.type) {
					case "data-practice-thinking":
						push(key, "You", plainText(str(data?.text) ?? ""));
						break;
					case "data-plugin-problem-submission": {
						const submitted = readPluginProblemSubmission(part.data);
						if (submitted) push(key, "You", [...plainText(typeof submitted.submission === "string" ? submitted.submission : ""), ...plainText(submitted.thinking)]);
						break;
					}
					case "data-subagent-artifact":
						push(key, "Agent", artifactBlocks(data));
						break;
					case "data-plan-block": {
						const blocks: string[] = [];
						for (const node of Array.isArray(data?.nodes) ? data.nodes : []) {
							const n = rec(node);
							blocks.push(...plainText(str(n?.title) ?? ""), ...shownText(str(n?.summary ?? n?.description) ?? ""));
						}
						push(key, "Plan", blocks);
						break;
					}
				}
			}
			continue;
		}

		if (m.role !== "assistant") continue;
		const failed = m.stopReason === "error" || m.stopReason === "aborted";
		let textN = 0;
		for (const [ci, block] of m.content.entries()) {
			if (block.type === "text") {
				push(`${m.id}-t${textN++}`, "Teacher", shownText(block.text));
				continue;
			}
			if (block.type !== "toolCall") continue;
			const args = rec(block.arguments);
			if (block.name === SEND_TO_USER_TOOL) {
				if (failed || failedOutputs.has(block.id)) continue;
				const text = str(args?.message ?? args?.text);
				if (text) push(`${m.id}-t${textN++}`, "Teacher", shownText(text));
				continue;
			}
			const part = toolParts.get(`${m.id}\0${block.id}`);
			if (!part || part.state === "output-error") continue;
			const key = `${m.id}:${ci}`;
			if (part.pluginQuestion) {
				if (part.pluginQuestion.status !== "posed") continue;
				const answer = readPluginQuestionAnswer(part.result?.details ?? part.output, part.pluginQuestion.snapshot);
				if (answer) {
					const given = typeof answer.answer === "string" ? plainText(answer.answer) : [];
					push(key, "Question", [...given, ...plainText(answer.readingThinking ?? ""), ...plainText(answer.thinking ?? "")]);
				}
				continue;
			}
			if (part.pluginProblem || block.name === PRACTICE_PROBLEM_TOOL) {
				// Never the pose's modelSolution: it belongs to the conclude card.
				push(key, "Problem", shownText(str(rec(part.input)?.statement) ?? ""));
				continue;
			}
			if (block.name === PRACTICE_CONCLUDE_TOOL) {
				if (args?.outcome === "dismissed") continue;
				const reveal = typeof part.reveal === "string" ? part.reveal : str(args?.solutionReveal);
				push(key, "Solution", [...shownText(str(args?.verdict) ?? ""), ...shownText(str(args?.feedback) ?? ""), ...shownText(reveal ?? "")]);
				continue;
			}
			const answer = part.state === "output-available" ? rec(part.output) : undefined;
			if (answer && typeof answer.questionText === "string" && (answer.kind === "quiz" || answer.kind === "ask" || answer.kind === "explain")) {
				push(key, answer.kind === "ask" ? "Question" : "Check", answeredBlocks(answer, part.input));
			}
		}
	}

	if (input.pendingQuestionVisible) {
		const pending = pendingQuestionOf(native);
		if (pending) {
			out.push({
				key: "dock", sourceMessageId: pending.messageId, kind: pending.tool === "ask_user_question" ? "Question" : "Check",
				unit: unitOf.get(pending.messageId) ?? null, time: timeOf.get(pending.messageId) ?? 0, order: order++, blocks: dockBlocks(pending.input),
			});
		}
	}

	for (const thread of sideThreads) {
		const anchor = thread.anchor.messageId;
		for (const [k, message] of thread.messages.entries()) {
			const at = Date.parse(message.at);
			out.push({
				key: `side:${thread.id}:${message.id}`, sourceMessageId: anchor, kind: "Side chat", unit: unitOf.get(anchor) ?? null,
				time: Number.isNaN(at) ? timeOf.get(anchor) ?? 0 : at, order: (orderOf.get(anchor) ?? 0) + 0.5 + k * 1e-6,
				sideThreadId: thread.id, sideMessageId: message.id,
				blocks: message.role === "assistant" ? shownText(message.text) : plainText(message.text),
			});
		}
	}
	return out.filter((u) => u.blocks.length > 0);
}

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 90;

function snippetOf(block: string, start: number, end: number): FindHit["snippet"] {
	const collapse = (text: string): string => text.replace(/\s+/g, " ");
	const before = collapse(block.slice(0, start));
	const after = collapse(block.slice(end));
	return {
		before: before.length > SNIPPET_BEFORE ? `…${before.slice(-SNIPPET_BEFORE)}` : before,
		match: collapse(block.slice(start, end)),
		after: after.length > SNIPPET_AFTER ? `${after.slice(0, SNIPPET_AFTER)}…` : after,
	};
}

/** Every occurrence of the query, newest first (time, then order, then position, all descending). */
export function findHits(units: readonly FindUnit[], query: string): FindHit[] {
	const found: Array<{ unit: FindUnit; hit: FindHit }> = [];
	for (const unit of units) {
		let occurrence = 0;
		for (const [block, text] of unit.blocks.entries()) {
			for (const { start, end } of findSessionTextMatches(text, query)) {
				found.push({ unit, hit: { unitKey: unit.key, block, occurrence: occurrence++, snippet: snippetOf(text, start, end) } });
			}
		}
	}
	found.sort((a, b) => b.unit.time - a.unit.time || b.unit.order - a.unit.order || b.hit.occurrence - a.hit.occurrence);
	return found.map((entry) => entry.hit);
}
