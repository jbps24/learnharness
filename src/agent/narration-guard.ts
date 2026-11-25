import type { ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText } from "../core/native-messages.ts";
import { isNarrationBlock, isNarrationDebtCleared, narrationText } from "../core/narration-debt.ts";
import { sendToUserApplies } from "./tools/send-to-user.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking. Send that content in full through `send_to_user`: the grading of the learner's answer, corrections, and a reply to anything the learner asked. Then pose the question again.";

export function narrationBlockReason(message: AssistantMessage, owedText?: string): string {
	const text = owedText ?? narrationText(message);
	if (!text) return NARRATION_BLOCK_REASON;
	return (
		"The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking. " +
		`Your hidden text: «${text}». ` +
		"Send that content in full through `send_to_user`: the grading of the learner's answer, corrections, and a reply to anything the learner asked. Then pose the question again."
	);
}

export const SEND_TO_USER_DELIVERY_RULE =
	"## Delivering your prose\n\n" +
	"Deliver learner-facing prose through `send_to_user`; ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
	"Send the complete explanation, example, or commentary before calling the accompanying question tool. " +
	"Question-only turns do not require an extra message. " +
	"A question whose response contains narration but no delivered prose may be rejected so you can deliver the missing explanation and retry. " +
	"When the learner has answered a question, your first call is `send_to_user` with your grading of that answer: what was right, what was wrong, and why. Only then pose the next question.";

export function narrationGuardApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return kind === "teacher" && sendToUserApplies(kind, model, toolsOverridden);
}

export { isNarrationBlock };

export function questionLacksDeliveredProse(message: AssistantMessage, toolName: string, delivered = false): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	if (!message.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean)) return false;
	return !delivered && !message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

export function makeNarrationGuard(): ToolCallHooks {
	let blocked = 0;
	// The sequential output/question tools run in call order. Credit only a
	// successful output already executed for THIS response, never a later
	// call, an older lesson, or a failed/aborted output. State is run-local.
	const delivered = new WeakMap<AssistantMessage, string>();
	// Narration hidden by an earlier blocked response, and the text delivered since.
	let owed: string | undefined;
	let deliveredSince = "";
	return {
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (blocked >= NARRATION_GUARD_MAX_BLOCKS) return undefined;
			if (!(QUESTION_TOOLS as readonly string[]).includes(toolCall.name)) return undefined;
			if (owed !== undefined) {
				if (!isNarrationDebtCleared(owed, deliveredSince)) {
					blocked++;
					deliveredSince = "";
					return { block: true, reason: narrationBlockReason(assistantMessage, owed) };
				}
				owed = undefined;
			}
			const hasNarration = assistantMessage.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean);
			const hasText = assistantMessage.content.some((b) => b.type === "text" && b.text.trim().length > 0);
			if (!hasNarration || hasText) return undefined;
			const hiddenHere = narrationText(assistantMessage);
			const sent = delivered.get(assistantMessage) ?? "";
			const cleared = hiddenHere ? isNarrationDebtCleared(hiddenHere, sent) : sent.trim().length > 0;
			if (cleared) return undefined;
			blocked++;
			if (hiddenHere) {
				owed = hiddenHere;
				deliveredSince = "";
			}
			return { block: true, reason: narrationBlockReason(assistantMessage, hiddenHere || undefined) };
		},
		afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
			const text = sendToUserText(toolCall);
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !result.isError && text !== undefined) {
				delivered.set(assistantMessage, (delivered.get(assistantMessage) ?? "") + text);
				deliveredSince += text;
			}
			return undefined;
		},
	};
}
