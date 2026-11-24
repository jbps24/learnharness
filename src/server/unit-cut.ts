/**
 * THE UNIT-CUT RUNNER (plan 001 part 5): once the turn that first tags the
 * next unit has settled, the finished unit(s) are replaced by a lesson record
 * — computed facts plus a model-written judgment of the learner. Runs inside
 * the compaction registry's mutex (`maintain`), so the next turn's gate waits
 * for it. A failed cut leaves the record untouched; the next turn retries.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { PlanTree } from "../core/contracts/plan.ts";
import {
	serializeForSummary,
	type LessonJudgment,
	type LessonRecordDetails,
	type LhMarkerMessage,
	type LhMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import {
	buildLessonRecordPrompt,
	mergeJudgment,
	parseLessonJudgment,
	recordFacts,
	renderLessonRecord,
} from "../core/lesson-record.ts";
import { newMessageId } from "../core/native-messages.ts";
import { currentUnitIndex, newestLessonRecord, teachTags, unitCutDue, unitIndexOf } from "../core/units.ts";
import { projectedContextTokens, setRunningUnit, subagentSummarizer, type CompactionDeps } from "./compaction.ts";
import { isTurnRunning } from "./turn-liveness.ts";

const EMPTY_JUDGMENT: LessonJudgment = { learnerWide: "", commitments: "", nodes: {} };

/** Markers that must not be summarized as lesson content. */
function withoutMarkers(messages: readonly LhMessage[]): LhMessage[] {
	return messages.filter(
		(m) => m.role !== "custom" || (m.customType !== "compaction" && m.customType !== "lesson-record" && m.customType !== "units-note" && m.customType !== "break-note" && m.customType !== "course-files" && m.customType !== "course-method" && m.customType !== "course-update" &&m.customType !== "exam-pattern" && m.customType !== "reference" &&m.customType !== "break-taken" && m.customType !== "break-skipped" && m.customType !== "break-ended"),
	);
}

export interface PreparedJudgment {
	spanKey: string;
	judgment: LessonJudgment;
	usages: Usage[];
}

/** A judgment computed ahead of the cut (during a unit-end break), keyed by the span it covers. */
// globalThis-backed: `next dev` compiles each route entry into its own module instance.
const g = globalThis as typeof globalThis & { __lhPreparedJudgments?: Map<string, PreparedJudgment> };
export const preparedJudgments: Map<string, PreparedJudgment> = (g.__lhPreparedJudgments ??= new Map());

/** The previous record id plus the ids of the non-marker messages in [s, k), joined. */
export function spanKeyOf(
	messages: readonly LhMessage[],
	s: number,
	k: number,
	previousRecordId?: string | null,
): string {
	return [previousRecordId ?? "", ...withoutMarkers(messages.slice(s, k)).map((m) => m.id)].join("|");
}

/** The span and facts a cut into unit `cur` works from. */
function cutInputs(tree: PlanTree, messages: readonly LhMessage[], cur: number, k: number) {
	const units = tree.units!;
	const finished = units.slice(0, cur).map((u) => u.id);
	const currentUnitId = units[cur]!.id;
	const previousRecord = newestLessonRecord(messages);
	const s = previousRecord ? Math.max(0, messages.findIndex((m) => m.id === previousRecord.details.firstKeptMessageId)) : 0;
	const taughtIds = [...new Set(teachTags(messages).filter((tag) => tag.messageIndex >= s && tag.messageIndex < k).map((tag) => tag.nodeId))];
	const previousJudgment = previousRecord?.details.judgment ?? null;
	// The merged judgment keeps every previous id and adds the taught ones.
	const judgmentNodeIds = [...new Set([...Object.keys(previousJudgment?.nodes ?? {}), ...taughtIds])];
	const facts = recordFacts(tree, messages, finished, currentUnitId, judgmentNodeIds);
	return { finished, currentUnitId, previousRecord, s, taughtIds, previousJudgment, facts };
}

/** Build the judgment prompt (with in-span compaction fallback) and verify it fits one request. */
function fitJudgmentPrompt(
	deps: CompactionDeps,
	chatId: string,
	messages: readonly LhMessage[],
	tree: PlanTree,
	cur: number,
	k: number,
): { prompt: string; taughtIds: string[]; previousJudgment: LessonJudgment | null } | "failed" {
	const { s, taughtIds, previousJudgment, facts } = cutInputs(tree, messages, cur, k);
	const promptFor = (spanText: string) => buildLessonRecordPrompt({ taughtIds, facts, previous: previousJudgment, spanText });

	let prompt = promptFor(serializeForSummary(withoutMarkers(messages.slice(s, k))));
	const promptFits = (p: string) => (deps.summaryRequestFits ? deps.summaryRequestFits(p) : Math.ceil(p.length / 4) <= deps.thresholdTokens);
	if (!promptFits(prompt)) {
		// Fall back to the newest in-span compaction: its summary + what rode after it.
		// A fallback compaction after a failed cut appends its marker past k, so scan the whole chat.
		let fallback: string | null = null;
		for (let i = messages.length - 1; i > s && fallback === null; i--) {
			const m = messages[i]!;
			if (m.role !== "custom" || m.customType !== "compaction") continue;
			const c = messages.findIndex((x) => x.id === (m.details as { firstKeptMessageId?: string } | undefined)?.firstKeptMessageId);
			if (c <= s || c >= k) continue;
			fallback = promptFor(`${m.content}\n\n${serializeForSummary(withoutMarkers(messages.slice(c, k)))}`);
		}
		if (fallback === null || !promptFits(fallback)) {
			console.info(`[chat ${chatId}] unit cut skipped — the finished unit does not fit one summary request`);
			return "failed";
		}
		prompt = fallback;
	}
	return { prompt, taughtIds, previousJudgment };
}

/** Run the summarizer on a fitted judgment prompt, parse, and retry once on rejection. */
async function summarizeLessonJudgment(
	deps: CompactionDeps,
	chatId: string,
	fitted: { prompt: string; taughtIds: string[]; previousJudgment: LessonJudgment | null },
): Promise<{ judgment: LessonJudgment; usages: Usage[] } | "failed"> {
	const { prompt, taughtIds, previousJudgment } = fitted;
	const summarize = deps.summarize ?? subagentSummarizer;
	const usages: Usage[] = [];
	let answer = await summarize(prompt, deps.engine);
	usages.push(answer.usage);
	let parsed = parseLessonJudgment(answer.summary, taughtIds);
	if (!parsed.ok) {
		const rejected = `${prompt}\n\nYour previous answer was rejected:\n${parsed.problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object only.`;
		answer = await summarize(rejected, deps.engine);
		usages.push(answer.usage);
		parsed = parseLessonJudgment(answer.summary, taughtIds);
	}
	if (!parsed.ok) {
		console.error(`[chat ${chatId}] unit cut failed: lesson judgment rejected twice:`, parsed.problems);
		return "failed";
	}
	return { judgment: mergeJudgment(previousJudgment ?? EMPTY_JUDGMENT, parsed.value), usages };
}

/** The judgment step of a unit cut: prompt, fit check and fallback, summarizer call, parse and one retry. */
export async function computeLessonJudgment(
	deps: CompactionDeps,
	chatId: string,
	messages: readonly LhMessage[],
	tree: PlanTree,
	cur: number,
	k: number,
): Promise<{ judgment: LessonJudgment; usages: Usage[] } | "failed"> {
	const fitted = fitJudgmentPrompt(deps, chatId, messages, tree, cur, k);
	if (fitted === "failed") return "failed";
	return summarizeLessonJudgment(deps, chatId, fitted);
}

export async function runUnitCut(
	deps: CompactionDeps,
	chatId: string,
): Promise<"done" | "failed" | "skipped"> {
	if (isTurnRunning(chatId)) return "skipped";
	const record = deps.chatStore.getChat(chatId);
	if (!record?.tree || !record.tree.units) return "skipped";
	const tree = record.tree;
	const messages = record.messages;
	if (!unitCutDue(tree, messages)) return "skipped";

	const cur = currentUnitIndex(tree, messages)!;

	// The boundary: the earliest teach tag whose node is in the current unit.
	const firstTag = teachTags(messages).find((tag) => unitIndexOf(tree, tag.nodeId) === cur);
	if (!firstTag) return "skipped";
	const k = firstTag.messageIndex;
	const { finished, currentUnitId, previousRecord, s, facts } = cutInputs(tree, messages, cur, k);

	// A prepared judgment is used only when its span is the real one; any other entry is dropped.
	const prepared = preparedJudgments.get(chatId);
	preparedJudgments.delete(chatId);
	const reusable = prepared && prepared.spanKey === spanKeyOf(messages, s, k, previousRecord?.id) ? prepared : null;

	// Check prompt fit before signalling a running cut so a no-fit bailout emits no status event.
	const fitted = reusable ? null : fitJudgmentPrompt(deps, chatId, messages, tree, cur, k);
	if (fitted === "failed") return "failed";

	setRunningUnit(chatId, cur + 1);
	emit("compaction-changed", { chatId, running: true, unit: cur + 1 });
	try {
		const computed = reusable ?? (await summarizeLessonJudgment(deps, chatId, fitted!));
		if (computed === "failed") return "failed";
		const { judgment, usages } = computed;
		const at = new Date().toISOString();
		const details: LessonRecordDetails = {
			firstKeptMessageId: messages[k]!.id,
			finishedUnitIds: finished,
			currentUnitId,
			judgment,
			model: deps.modelId,
			tokensBefore: projectedContextTokens(deps.projectMessages?.(record) ?? messages, deps.systemPromptTokens, deps.includeReasoning ? deps.engine.model : undefined),
			at,
		};
		const marker: LhMarkerMessage = {
			id: newMessageId(),
			role: "custom",
			customType: "lesson-record",
			content: renderLessonRecord(facts, judgment),
			display: true,
			details,
			timestamp: Date.now(),
		};
		// Re-read: messages may have arrived while the summary ran. The marker
		// goes where the summarized chat ended (the compactPass seam, #518).
		const current = deps.chatStore.getChat(chatId);
		if (!current) throw new Error(`Chat not found: ${chatId}`);
		const end = messages.length;
		deps.chatStore.saveMessages(chatId, [...current.messages.slice(0, end), marker, ...current.messages.slice(end)]);
		deps.chatStore.appendTurnUsage(chatId, {
			id: crypto.randomUUID(),
			messageId: marker.id,
			at,
			model: deps.modelId,
			steps: usages.map((usage) => ({
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadTokens: usage.cacheRead,
				cacheWriteTokens: usage.cacheWrite,
				cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
				reasoningTokens: usage.reasoning ?? 0,
			})),
		});
		emit("record-changed", { chatId });
		return "done";
	} catch (err) {
		console.error(`[chat ${chatId}] unit cut failed:`, err);
		return "failed";
	} finally {
		setRunningUnit(chatId, undefined);
		emit("compaction-changed", { chatId, running: false });
	}
}
