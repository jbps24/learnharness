/**
 * THE VIEW MODEL (Wave D, owner-approved 2026-09-26): the client's transcript
 * view — native record messages (+ the live turn's working messages) grouped
 * into today's exact render shape. The golden master is the pre-Wave-D UI
 * (owner fork 1): everything the agent produces is ONE continuous document
 * per run — step separators between the loop's steps, artifact and answered
 * cards inline, the teacher's reaction continuing below an answered quiz.
 *
 * This is the grouping canon of the deleted server-side projection
 * (core/projection.ts, Wave B), moved client-side, app-owned, with zero AI-SDK
 * types — plus the LIVE-TURN layer the projection never had: mid-turn tool
 * execution states (input-streaming → input-available/output-error/output),
 * so the dock mounts only after a call clears the validation boundary
 * (tool_execution_end) and the shimmer names the running activity.
 *
 * GROUPING RULE: one assistant view message per GROUP — consecutive assistant
 * + toolResult messages, bounded by user/marker messages; toolResults attach
 * to the tool part of their call (searching backward — an answered quiz's
 * result lands on the part that asked it, even turns later); a group's id is
 * its FIRST assistant message's id.
 *
 * Plan blocks: a plan-block marker has no message of its own — its data part
 * splices into the preceding assistant group, IN FLOW right after the last
 * successful plan_init call (the presentation moment).
 *
 * Question tools on the wire (owner fork 2): the agent's closing
 * tool_execution_end carries the in-memory "Question posed" placeholder —
 * projectView IGNORES clean question executions (the part stays
 * input-available; the learner's answer arrives as a real toolResult). The
 * placeholder never persists, so settled records never see it.
 *
 * Pure and deterministic: client-safe (no node deps), same input → same view.
 */

import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import { modelSolutionForConclude, PRACTICE_CONCLUDE_TOOL, problemInputForConclude, SEND_TO_USER_TOOL, sendToUserText, pluginQuestionResultMatches } from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation, readPluginQuestionCancellation, type PluginQuestionAnnotationRead } from "./plugin-questions.ts";
import { pluginProblemForCall, type PluginProblemSnapshot } from "./plugin-problems.ts";
import { activeCompactionOf, type CompactionDetails } from "./compaction.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import {
	createNarrationDebtTracker,
	isNarrationDebtCleared,
	isNarrationRejection,
	stepNarrationDebt,
	type NarrationDebtState,
} from "./narration-debt.ts";
import { breakState, breakTimings } from "./breaks.ts";
import { BREAK_DEFAULTS } from "./settings.ts";
import type { SubagentArtifactData, SubagentResultMeta } from "./contracts/jobs.ts";
import type { LessonRecordDetails, PlanBlockData } from "./contracts/chat.ts";
import type { PlanUnit } from "./contracts/plan.ts";

/** One projected transcript part consumed by host renderers and phase/input
 * scanners. type selects the part vocabulary; common fields are optional
 * because text, tools and data parts carry different payloads. Additional
 * fields remain unknown through the index signature and require narrowing. */
export interface LhViewPart extends Record<string, unknown> {
	type: string;
	id?: string;
	text?: string;
	state?: string;
	toolCallId?: string;
	/** Native location, retained across display grouping (client-only). */
	sourceMessageId?: string;
	sourceContentIndex?: number;
	/** Must be selected before any generic tool renderer; never a raw trace. */
	pluginQuestion?: Exclude<PluginQuestionAnnotationRead, { status: "absent" }>;
	pluginProblem?: PluginProblemSnapshot;
	input?: unknown;
	output?: unknown;
	rawInput?: unknown;
	errorText?: string;
	/** Native result retained for public plugin renderers and readable fallbacks. */
	result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
	data?: unknown;
}

/** View part type for hidden narration recovered as a fallback above a question. */
export const OWED_NARRATION_PART_TYPE = "data-owed-narration" as const;

/** Marker label shown over recovered narration. */
const OWED_NARRATION_LABEL = "Tutor's notes (not sent as a message)";

/** Payload of an owed-narration fallback part in `projectView`. */
export interface OwedNarrationData {
	text: string;
	label: string;
}

/** A view message: user (bubble) or assistant (one continuous run). */
export interface LhViewMessage {
	id: string;
	role: "user" | "assistant";
	parts: LhViewPart[];
	/** The subagentResult meta the steer cards read (marker details). */
	metadata?: unknown;
}

/** A tool call's live execution outcome (from tool_execution_end). */
export interface LiveExecution {
	isError: boolean;
	/** The clean result's details payload (the card's output). */
	output?: unknown;
	/** The failure text (output-error parts). */
	errorText?: string;
	result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
}

/** The live turn's execution layer, maintained by the session hook. */
export interface LiveTurnState {
	/** toolCallId → its execution outcome seen so far. */
	executions: ReadonlyMap<string, LiveExecution>;
	/** True while the turn runs — calls with no execution yet render
	 *  input-streaming (the shimmer); settled dangling calls render
	 *  input-available (the dock mounts from the record). */
	inFlight: boolean;
	/** Ids of the messages THIS consume is streaming (optimistic round 3,
	 *  2026-10-02): an arrived-but-empty streaming message projects one
	 *  empty reasoning part — the thinking row — so the placeholder's
	 *  handoff is seamless; settled empty messages stay hidden. */
	streamingIds: ReadonlySet<string>;
}

function textPart(text: string): LhViewPart {
	return { type: "text", text, state: "done" };
}

/** The result a tool part should show, from a native toolResult. */
function applyResult(part: LhViewPart, result: ToolResultMessage): void {
	if (part.pluginQuestion) {
		// Authored payload/error prose must never escape through generic trace.
		if (result.isError) { part.state = "output-error"; return; }
		part.state = "output-available";
		part.output = result.details;
		return;
	}
	part.result = { content: result.content, details: result.details, isError: result.isError };
	if (result.isError) {
		part.state = "output-error";
		part.rawInput = part.input;
		const text = result.content.find((c) => c.type === "text");
		part.errorText = text && text.type === "text" ? text.text : "The tool call failed.";
	} else {
		part.state = "output-available";
		part.output = result.details;
	}
}

/** Does this assistant group carry a successful plan_init (the splice target)? */
function lastSuccessfulPlanInit(parts: LhViewPart[]): number {
	let idx = -1;
	parts.forEach((p, i) => {
		if (p.type !== "tool-plan_init") return;
		const ok = (p.output as { ok?: unknown } | undefined)?.ok;
		if (ok === true) idx = i;
	});
	return idx;
}

/** The units of the newest plan tree any plan tool result carries. */
export function latestPlanUnits(messages: readonly LhMessage[]): PlanUnit[] | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || !m.toolName.startsWith("plan_")) continue;
		const tree = (m.details as { ok?: unknown; tree?: { units?: PlanUnit[] } } | undefined)?.tree;
		if (tree) return tree.units;
	}
	return undefined;
}

/** Project the native record (+ live turn working list) into the client's
 *  view messages. Pure: the same input always projects to the same list. */
export function projectView(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[] {
	const out: LhViewMessage[] = [];
	const debtTracker = createNarrationDebtTracker();
	let lastOwedShown: string | undefined;
	// Output calls become text rather than tool parts, so read settled
	// failures up front: a failed call must retain the normal error path.
	const outputErrors = new Map<string, ToolResultMessage>();
	const erroredCalls = new Set<unknown>();
	const deliveredCalls = new Set<unknown>();
	const narrationRejectedCalls = new Set<unknown>();
	const openCalls = new Map<string, unknown>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") openCalls.set(block.id, block);
			}
		} else if (message.role === "toolResult") {
			if (message.toolName === SEND_TO_USER_TOOL && message.isError) {
				outputErrors.set(message.toolCallId, message);
			}
			const call = openCalls.get(message.toolCallId);
			if (call) {
				openCalls.delete(message.toolCallId);
				if (message.isError) {
					erroredCalls.add(call);
					const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
					if (isNarrationRejection(text)) narrationRejectedCalls.add(call);
				} else if (message.toolName === SEND_TO_USER_TOOL) {
					deliveredCalls.add(call);
				}
			}
		}
	}
	const isActiveQuestionCall = (block: AssistantMessage["content"][number]): boolean =>
		block.type === "toolCall" &&
		(QUESTION_TOOLS as readonly string[]).includes(block.name) &&
		!erroredCalls.has(block) &&
		live?.executions.get(block.id)?.isError !== true;

	const lastAssistant = (): LhViewMessage | undefined => {
		const last = out[out.length - 1];
		return last && last.role === "assistant" ? last : undefined;
	};
	const findToolPart = (result: LhMessage & ToolResultMessage): LhViewPart | undefined => {
		for (let i = out.length - 1; i >= 0; i--) {
			// NEWEST-FIRST part scan within a group (the Lacan heal, 2026-10-04):
			// a result pairs with the most RECENT call carrying its id. Unique
			// ids (the uniquifier guarantees them for new turns) make scan order
		// irrelevant; for legacy duplicate-id records (DeepSeek's per-response
		// `call_0`) this routes each answer to its own call instead of letting
		// a later result overwrite an earlier question's card.
			const parts = out[i]!.parts;
			for (let p = parts.length - 1; p >= 0; p--) {
				const part = parts[p]!;
				if (!part.type.startsWith("tool-") || part.toolCallId !== result.toolCallId) continue;
				if (part.pluginQuestion) {
					const occurrence = { messageId: part.sourceMessageId!, contentIndex: part.sourceContentIndex!, toolCallId: part.toolCallId!, toolName: part.type.slice(5) };
					if (pluginQuestionResultMatches(result, occurrence, part.pluginQuestion) || (result.isError && part.pluginQuestion.status !== "posed")) return part;
					continue;
				}
				if (!result.lhQuestionOccurrence && !readPluginQuestionCancellation(result.details)) return part;
			}
		}
		return undefined;
	};

	// The active compaction (owner round 14): the fold emits the CUT
	// DIVIDER — the longer, at-the-seam marker — immediately BEFORE the
	// first kept message, so the transcript shows exactly where history
	// was summarized away. Everything before it stays visible to the
	// user (full history is never hidden); only the MODEL's context jumps.
	const compaction = activeCompactionOf(messages);

	// Unit cuts (plan 001 part 8): every lesson-record gets a divider before
	// its kept message, not only the newest. Titles read the live tree.
	const unitCuts = new Map<string, Array<LhMarkerMessage & { details: LessonRecordDetails }>>();
	for (const m of messages) {
		if (m.role !== "custom" || m.customType !== "lesson-record") continue;
		const details = m.details as LessonRecordDetails | undefined;
		if (!details) continue;
		const list = unitCuts.get(details.firstKeptMessageId) ?? [];
		list.push(m as LhMarkerMessage & { details: LessonRecordDetails });
		unitCuts.set(details.firstKeptMessageId, list);
	}
	const liveUnits = unitCuts.size > 0 ? latestPlanUnits(messages) : undefined;

	for (const m of messages) {
		const role = (m as { role?: string }).role;

		for (const record of unitCuts.get(m.id) ?? []) {
			const { currentUnitId, finishedUnitIds } = record.details;
			const at = liveUnits?.findIndex((u) => u.id === currentUnitId) ?? -1;
			out.push({
				id: `unit_${record.id}`,
				role: "user",
				parts: [
					{
						type: "data-unit-cut",
							sourceMessageId: m.id,
						id: `uc_${record.id}`,
						data: {
							unitIndex: at >= 0 ? at + 1 : finishedUnitIds.length + 1,
							title: at >= 0 ? liveUnits![at]!.title : currentUnitId,
						},
					},
				],
			});
		}

		if (compaction && m.id === compaction.details.firstKeptMessageId) {
			out.push({
				id: `cut_${compaction.id}`,
				role: "user",
				parts: [
					{
						type: "data-compaction-cut",
							sourceMessageId: m.id,
						id: `cc_${compaction.id}`,
						data: { content: compaction.content, details: compaction.details },
					},
				],
			});
		}

		stepNarrationDebt(debtTracker, m);
		if (debtTracker.owed === undefined) lastOwedShown = undefined;

		if (role === "user") {
			const content = m.content as string | Array<{ type: string; text?: string }>;
			const parts = typeof content === "string" ? [textPart(content)] : content.flatMap((block): LhViewPart[] => {
				if (block.type === "text") return [textPart(block.text as string)];
				if (block.type === "image") return [{ ...block as ImageContent }];
				return [];
			});
			for (const part of parts) part.sourceMessageId = m.id;
				out.push({ id: m.id, role: "user", parts });
			continue;
		}

		if (role === "custom") {
			const before = out.length;
				projectMarker(m as LhMarkerMessage, out);
				for (const row of out.slice(before)) for (const part of row.parts) part.sourceMessageId = m.id;
			continue;
		}

		if (role === "toolResult") {
			if ((m as ToolResultMessage).toolName === "suggest_break") {
				// Plan 002 part 6: an ok call projects one divider; a refused one nothing.
				const data = breakPartData(messages, messages.indexOf(m));
				if (data) out.push({ id: m.id, role: "user", parts: [{ type: "data-break", sourceMessageId: m.id, id: `br_${data.toolCallId}`, data }] });
				continue;
			}
			applyResultTo(findToolPart(m as LhMessage & ToolResultMessage), m as ToolResultMessage);
			continue;
		}

		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			// OWNER RULING (2026-09-26): reasoning ALWAYS renders above the
			// message it belongs to. Providers emit trailing reasoning tokens
			// (GLM fires a final reasoning burst after the answer), which
			// lands the thinking block AFTER the text in the persisted
			// content — presenting arrival order verbatim put the reasoning
			// UNDER the message. The view canon owns presentation order:
			// stable-partition each assistant message, reasoning parts first
			// (their own order kept), then everything else.
			const rest: LhViewPart[] = [];
			const reasoning: LhViewPart[] = [];
			let textN = 0;
			let reasoningN = 0;
			// LIVE IS POSITIVE EVIDENCE (owner, 2026-10-05): a call renders
			// live ONLY when its own message is streaming THIS turn — session
			// busyness alone can never resurrect a settled call (the practice
			// bug: a thinking submission flipped the POSE turn's problem call
			// back to a spinner mid-transcript; live cards belong at the
			// bottom, and this gate is what puts them there by construction).
			const streamingMessage = live?.streamingIds.has(m.id) === true;
			// Plan 021 part 3: the guard's budget is spent and the question went
			// through with hidden narration still owed: show it above the question.
			let debt: NarrationDebtState = assistant.content.some(isActiveQuestionCall)
				? { owed: debtTracker.owed, delivered: debtTracker.delivered }
				: { owed: undefined, delivered: "" };
			for (const [contentIndex, block] of assistant.content.entries()) {
				if (block.type === "text") {
					rest.push({ type: "text", id: `${m.id}-t${textN++}`, text: block.text, state: "done" });
				} else if (block.type === "thinking") {
					reasoning.push({ type: "reasoning", id: `${m.id}-r${reasoningN++}`, text: block.thinking, state: "done" });
				} else if (block.type === "toolCall") {
					// The break offer renders from its result (the divider), never as a tool card.
					if (block.name === "suggest_break") continue;
					if (
						debt.owed !== undefined &&
						block.name === SEND_TO_USER_TOOL &&
						assistant.stopReason !== "error" &&
						assistant.stopReason !== "aborted" &&
						!erroredCalls.has(block) &&
						(deliveredCalls.has(block) || live?.executions.get(block.id)?.isError === false)
					) {
						debt.delivered += sendToUserText(block) ?? "";
						if (isNarrationDebtCleared(debt.owed, debt.delivered)) {
							debt = { owed: undefined, delivered: "" };
						}
					} else if (debt.owed !== undefined && narrationRejectedCalls.has(block)) {
						debt.delivered = "";
					}
					if (debt.owed !== undefined && debt.owed !== lastOwedShown && isActiveQuestionCall(block)) {
						lastOwedShown = debt.owed;
						const data: OwedNarrationData = { text: debt.owed, label: OWED_NARRATION_LABEL };
						rest.push({ type: OWED_NARRATION_PART_TYPE, id: `${m.id}-owed`, data });
						debt = { owed: undefined, delivered: "" };
					}
					const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
					if (annotation.status !== "absent") {
						// Source position, not reasoning-partitioned/grouped view index.
						rest.push({ type: `tool-${block.name}`, toolCallId: block.id,
							sourceMessageId: m.id, sourceContentIndex: contentIndex, pluginQuestion: annotation,
							state: annotation.status === "posed" ? "input-available" : streamingMessage ? "input-streaming" : "output-error" });
						continue;
					}
					const part = toolPartOf(block, live, streamingMessage);
					const pluginProblem = pluginProblemForCall(messages, { messageId: m.id, contentIndex, toolCallId: block.id, toolName: block.name });
					if (pluginProblem) { part.pluginProblem = pluginProblem; part.input = pluginProblem.input; }
					part.sourceMessageId = m.id;
					part.sourceContentIndex = contentIndex;
					if (block.name === SEND_TO_USER_TOOL) {
						// Failed/aborted generations never execute their calls;
						// the provider error/abort UI already owns that outcome.
						if (assistant.stopReason === "error" || assistant.stopReason === "aborted") continue;
						const error = outputErrors.get(block.id);
						if (error) applyResult(part, error);
						if (part.state === "output-error") {
							rest.push(part);
						} else {
							const text = sendToUserText(block);
							if (text !== undefined) {
								rest.push({ type: "text", id: `${m.id}-t${textN++}`, text, state: "done" });
							}
						}
						// No live tool card or acknowledgement: this channel is
						// ordinary prose, including while its arguments stream.
						continue;
					}
					// The conclusion's reveal join (owner round, 2026-10-05): the
					// hero of a conclude card is the modelSolution committed at POSE
					// time — a record fold, enriched here so the card renders pure.
					if (block.name === PRACTICE_CONCLUDE_TOOL) {
						part.reveal = modelSolutionForConclude(messages, block.id);
						part.problemInput = problemInputForConclude(messages, block.id);
					}
					rest.push(part);
				}
			}
			const parts: LhViewPart[] = [...reasoning, ...rest];
				for (const part of parts) part.sourceMessageId ??= m.id;
			if (parts.length === 0) {
				// An arrived-but-silent STREAMING message (owner, optimistic
				// round 3, 2026-10-02): the turn's first applied event can
				// carry empty content — project ONE empty reasoning part so
				// the message's ARRIVAL renders the thinking row (chat.tsx's
				// Reasoning isStreamings the last part: the same spinner +
				// shimmer as the placeholder it replaces — the handoff is
				// seamless and the two can never double). Settled empty
				// messages stay hidden (presentation-only).
				if (live?.streamingIds.has(m.id)) {
					parts.push({ type: "reasoning", id: `${m.id}-r0`, text: "", state: "done", sourceMessageId: m.id });
				} else {
					continue;
				}
			}
			const group = lastAssistant();
			if (group) {
				// Same group: the step separator renders between the steps.
				group.parts.push({ type: "step-start", sourceMessageId: m.id }, ...parts);
			} else {
				out.push({ id: m.id, role: "assistant", parts: [{ type: "step-start", sourceMessageId: m.id }, ...parts] });
			}
			continue;
		}
	}

	return out;
}

const isOkBreakResult = (m: LhMessage): boolean =>
	m.role === "toolResult" && m.toolName === "suggest_break" && !m.isError && (m.details as { ok?: boolean } | null)?.ok !== false;

function hasOneMoreQuestion(messages: readonly LhMessage[], index: number, toolCallId: string): boolean {
	if (((messages[index] as ToolResultMessage).details as { oneMoreQuestion?: unknown } | null)?.oneMoreQuestion === true) return true;
	for (let i = index - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (let c = m.content.length - 1; c >= 0; c--) {
			const block = m.content[c]!;
			if (block.type === "toolCall" && block.id === toolCallId && block.name === "suggest_break") {
				return (block.arguments as { oneMoreQuestion?: unknown } | null)?.oneMoreQuestion === true;
			}
		}
	}
	return false;
}

/** The `data-break` payload of the suggest_break result at `index`, read from
 *  breakState as of just before the next ok suggestion; null when refused. */
function breakPartData(messages: readonly LhMessage[], index: number): Record<string, unknown> | null {
	if (!isOkBreakResult(messages[index]!)) return null;
	let end = messages.length;
	for (let j = index + 1; j < messages.length; j++) {
		if (isOkBreakResult(messages[j]!)) { end = j; break; }
	}
	const s = breakState(messages.slice(0, end), undefined, breakTimings(BREAK_DEFAULTS), true, 0).latest;
	if (!s) return null;
	const state = s.outcome === "pending" ? "offered" : s.outcome;
	const data: Record<string, unknown> = { toolCallId: s.toolCallId, state };
	if (s.takenAt !== undefined) data.takenAt = s.takenAt;
	if (s.lengthMinutes !== undefined) data.lengthMinutes = s.lengthMinutes;
	if (s.breakMs !== undefined) data.breakMs = s.breakMs;
	if (hasOneMoreQuestion(messages, index, s.toolCallId)) data.oneMoreQuestion = true;
	return data;
}

/** The dock-owned tools: question tools (client-owned results — the dock
 *  mounts on the dangling call) and the practice pose (its ack is FINAL —
 *  details: null, never replaced — and the card + dock read the call's
 *  input; the placeholder must never flip the part to output-available).
 *  PRACTICE (2026-10-04): problem joins the placeholder fork; conclude is
 *  a NORMAL tool part (its result acks with no payload, details null —
 *  but the ConcludeCard reads the call's input, and output-available with
 *  output undefined renders fine). */
function isPlaceholderResultTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name) || name === "problem";
}

/** A tool call block → its view part, with the live execution layer.
 * `streamingMessage` — POSITIVE EVIDENCE (owner, 2026-10-05): this call's
 * own message is streaming THIS turn. The input-streaming shimmer keys on
 * it, never on session busyness: a call from a settled message can never
 * render live, whatever else is running. */
function toolPartOf(
	block: { id: string; name: string; arguments?: unknown },
	live: LiveTurnState | undefined,
	streamingMessage: boolean,
): LhViewPart {
	const part: LhViewPart = {
		type: `tool-${block.name}`,
		toolCallId: block.id,
		input: block.arguments,
	};
	const exec = live?.executions.get(block.id);
	const isQuestion = isPlaceholderResultTool(block.name);
	if (exec) {
		if (exec.result) part.result = exec.result;
		if (exec.isError) {
			// An invalid call NEVER becomes input-available — the dock's mount
			// gate keys on the clean execution end (the live modal-realism
			// crash: a malformed quiz must never mount).
			part.state = "output-error";
			part.rawInput = block.arguments;
			part.errorText = exec.errorText ?? "The tool call failed.";
		} else if (isQuestion) {
			// Fork 2: the clean "Question posed" placeholder is IGNORED —
			// question tools are client-owned; the dock mounts on the clean
			// end, the answer arrives as a real toolResult.
			part.state = "input-available";
		} else {
			part.state = "output-available";
			part.output = exec.output;
		}
	} else {
		// No execution yet: live ONLY on positive evidence — the call's own
		// message is streaming this turn (its arguments may literally be
		// mid-write). Anything else is a dangling call from a settled
		// message — the dock's pending state, never a shimmer.
		part.state = streamingMessage ? "input-streaming" : "input-available";
	}
	return part;
}

function applyResultTo(part: LhViewPart | undefined, result: ToolResultMessage): void {
	if (part) {
		// Fork 2 (owner, Wave D): the clean "Question posed" placeholder
		// (details: null — tool-execute questionResult) is client-owned
		// question territory. The dock mounts on the dangling call; the
		// AnsweredCard renders only the learner's REAL answer (details set).
		// Flipping the part to output-available on the placeholder would hand
		// AnsweredCard a null and crash the render (the live crash, 2026-09-26).
		const tool = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
		const isQuestion = isPlaceholderResultTool(tool);
		if (!result.isError && ((isQuestion && result.details == null) || part.pluginProblem)) {
			// The placeholder fork (fork 2) stands: the clean pose/ask ack carries
			// no card data — NEVER output-available. But the call IS settled
			// (the practice bug, 2026-10-05: this early-return left the part on
			// whatever toolPartOf guessed, which mid-turn resurrected a settled
			// problem as a live spinner). input-available is the settled truth:
			// the ProblemCard reads the call's input, the dock keys on the
			// native fold — neither wants the ack's (null) payload.
			part.state = "input-available";
			return;
		}
		applyResult(part, result);
	}
	// A result with no visible part (e.g. a call whose assistant message
	// rendered nothing) is dropped from the view — the record keeps it.
}

/** A marker's projected message (handoff/steers) or splice (plan block). */
function projectMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void {
	switch (marker.customType) {
		case "graph-context": {
			// The session's map context (owner, 2026-10-04): user-side —
			// a minimal collapsible card ABOVE the first user message;
			// never a text bubble (scaffolding, like the thinking card).
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-graph-context", id: `gc_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "probe-handoff": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-probe-handoff", id: `ph_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "subagent-steer": {
			const meta = marker.details as SubagentResultMeta;
			const artifact = marker.details as {
				kind: SubagentArtifactData["kind"];
				result: SubagentArtifactData["result"];
				ui?: SubagentArtifactData["ui"];
			};
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [
					textPart(marker.content),
					{
						type: "data-subagent-artifact",
						id: `sa_${marker.id}`,
						data: { kind: artifact.kind, result: artifact.result, ui: artifact.ui },
					},
				],
			});
			return;
		}
		case "subagent-abort": {
			const meta = marker.details as SubagentResultMeta & { aborted: true };
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [textPart(marker.content), { type: "data-subagent-aborted", id: `sa_${marker.id}`, data: meta }],
			});
			return;
		}
		case "plugin-problem-submission": {
			out.push({ id: marker.id, role: "user", parts: [{ type: "data-plugin-problem-submission", id: `ps_${marker.id}`, data: marker.details }] });
			return;
		}
		case "practice-thinking": {
			// The learner's working trace / committed answer (practice
			// sessions): a user-side card keyed on the structured details
			// (problemCallId, commit, text) — the register lives in the card,
			// not re-parsed from content.
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-practice-thinking", id: `pt_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "practice-next": {
			// The learner's explicit move-on signal (owner round 16): a compact
			// centered system line — the mono-caps chrome register, not prose.
			// The model reads the marker's content; the transcript never shows
			// it (the label is chrome, single-sourced in the renderer).
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-practice-next", id: `pn_${marker.id}`, data: null }],
			});
			return;
		}
		case "side-question":
		case "side-question-told":
			// Raw context entries do not split the teaching segment or render
			// loud transcript pills. Its quiet speech-bubble reopens the saved
			// conversation in the floating/docked companion.
			return;
		case "problem-dismissed":
			// UI-only (the ask-style dismissal): the synthesized conclude
			// pair — which rides the NEXT input — carries the record's face.
			return;
		case "break-note":
		case "break-taken":
		case "break-skipped":
		case "break-ended":
			// Plan 002 part 6: markers render nothing; the divider comes from the call.
			return;
		case "units-note":
			// Wire-only session note (plan 001 part 6): renders nothing.
			return;
		case "compaction-skipped":
			// Plan 022 part 3: a one-line chat notice, never sent to the model.
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-compaction-skipped", id: `cs_${marker.id}`, data: { content: marker.content } }],
			});
			return;
		case "lesson-record":
			// Never rendered (plan 001 part 8): the unit divider is emitted by
			// the fold at the kept boundary, the record itself stays model-facing.
			return;
		case "compaction": {
			// THE MOMENT DIVIDER (owner round 14): minimal centered small
			// text at the compaction moment — where the user currently is
			// (the marker appends at the record's tail). Clicking opens the
			// full summary. The cut divider is emitted by the fold loop at
			// the kept boundary (see projectView).
			out.push({
				id: marker.id,
				role: "user",
				parts: [
					{
					type: "data-compaction",
					id: `cm_${marker.id}`,
					data: { content: marker.content, details: marker.details as CompactionDetails },
				},
				],
			});
			return;
		}
		case "plan-block": {
			// No message of its own: splice into the preceding assistant
			// group, IN FLOW after the last successful plan_init call.
			const group = out[out.length - 1];
			if (!group || group.role !== "assistant") return;
			const idx = lastSuccessfulPlanInit(group.parts);
			if (idx === -1) return;
			const { block } = marker.details as { planCallId: string; block: PlanBlockData };
			group.parts.splice(idx + 1, 0, { type: "data-plan-block", sourceMessageId: marker.id, id: marker.id, data: block });
			return;
		}
	}
}
