import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SEND_TO_USER_TOOL, sendToUserText } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";

export interface NarrationDebtMessage {
	role: string;
	content: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

const REJECTION_MARKERS = [
	"contains narration but no delivered learner-facing prose",
	"The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking.",
] as const;

export function isNarrationBlock(block: { type: string; thinkingSignature?: string }): boolean {
	if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") return false;
	try {
		const b64 = block.thinkingSignature.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return atob(padded).slice(0, 60).includes("narration");
	} catch {
		return false;
	}
}

/** The text of the message's hidden narration blocks, trimmed and joined. */
export function narrationText(message: AssistantMessage): string {
	return message.content
		.flatMap((b) => (b.type === "thinking" && isNarrationBlock(b) && b.thinking.trim() ? [b.thinking.trim()] : []))
		.join("\n\n");
}

/** True for the guard's rejection text, in the old and the new wording. */
export function isNarrationRejection(text: string): boolean {
	return REJECTION_MARKERS.some((marker) => text.includes(marker));
}

/** The debt is paid once the delivered text is at least as long as the hidden narration. */
export function isNarrationDebtCleared(owed: string, delivered: string): boolean {
	return delivered.trim().length >= owed.trim().length;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
}

export interface NarrationDebtState {
	owed: string | undefined;
	delivered: string;
}

export interface NarrationDebtTracker {
	calls: Map<string, { message: AssistantMessage; call: unknown }>;
	owed: string | undefined;
	delivered: string;
}

/** Creates an incremental narration-debt tracker for single-pass transcript scans. */
export function createNarrationDebtTracker(): NarrationDebtTracker {
	return { calls: new Map(), owed: undefined, delivered: "" };
}

/** Advances a narration-debt tracker by one transcript message, resetting on run boundaries. */
export function stepNarrationDebt(tracker: NarrationDebtTracker, m: NarrationDebtMessage): void {
	if (m.role === "user" || m.role === "custom") {
		tracker.owed = undefined;
		tracker.delivered = "";
		return;
	}
	if (m.role === "assistant" && Array.isArray(m.content)) {
		for (const b of m.content as { type?: string; id?: string }[]) {
			if (b?.type === "toolCall" && typeof b.id === "string") {
				tracker.calls.set(b.id, { message: m as unknown as AssistantMessage, call: b });
			}
		}
		return;
	}
	if (m.role === "toolResult") {
		const rejection = Boolean(m.isError && isNarrationRejection(textOf(m.content)));
		const entry = m.toolCallId ? tracker.calls.get(m.toolCallId) : undefined;
		const toolName = m.toolName ?? (entry?.call as { name?: string } | undefined)?.name;
		if (toolName && (QUESTION_TOOLS as readonly string[]).includes(toolName) && !m.isError) {
			tracker.owed = undefined;
			tracker.delivered = "";
			return;
		}
		if (!entry) return;
		if (rejection) {
			if (tracker.owed !== undefined) {
				tracker.delivered = "";
			} else {
				const text = narrationText(entry.message);
				if (text) {
					tracker.owed = text;
					tracker.delivered = "";
				}
			}
		} else if (!m.isError && toolName === SEND_TO_USER_TOOL && tracker.owed !== undefined) {
			tracker.delivered += sendToUserText(entry.call) ?? "";
			if (isNarrationDebtCleared(tracker.owed, tracker.delivered)) {
				tracker.owed = undefined;
				tracker.delivered = "";
			}
		}
	}
}

/** Owed narration and delivered text accumulated since the last guard block in the current run. */
export function owedNarrationState(messages: readonly NarrationDebtMessage[]): NarrationDebtState {
	const tracker = createNarrationDebtTracker();
	for (const m of messages) stepNarrationDebt(tracker, m);
	return { owed: tracker.owed, delivered: tracker.delivered };
}

/** The hidden narration still owed to the learner at the end of the sequence, if any. */
export function owedNarration(messages: readonly NarrationDebtMessage[]): string | undefined {
	return owedNarrationState(messages).owed;
}
