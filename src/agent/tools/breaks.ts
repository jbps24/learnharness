import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { breakState, breakTimings } from "../../core/breaks.ts";
import { hasUnresolvedQuestion } from "../../core/native-messages.ts";
import type { ChatStore } from "../../core/ports.ts";
import { teachTags } from "../../core/units.ts";

export interface BreakToolContext {
	chatId: string;
	chatStore: ChatStore;
	breaks: () => { enabled: boolean; intervalMinutes: number; lengthMinutes: number; resetMinutes: number };
	now: () => number;
}

const suggestBreakInput = Type.Object({
	requestedBy: Type.Union([Type.Literal("window"), Type.Literal("learner")]),
	oneMoreQuestion: Type.Optional(Type.Boolean()),
});

const OK1 = "Break offered. End your turn now; the learner chooses in the app.";
const R1 =
	'No break is due right now. Suggest a break only after a [Session note] says one is due, or when the learner asks (requestedBy "learner").';
const R2 = "Teaching hasn't started yet. A due break waits for the first closed point in teaching.";
const R3 = "A question is still open. Suggest the break after it is answered and the step is closed.";
const R4 = "A break offer is already open.";
const R5 = 'oneMoreQuestion only goes with requestedBy "window".';

/**
 * suggest_break — the teacher's break offer. SERVER-SIDE. A window request
 * is guarded (open window, teaching started, no open question); a learner
 * request is only refused while an offer is pending or a break is taken.
 */
export function suggestBreakTool(ctx: BreakToolContext): Record<string, AgentTool<any>> {
	return {
		suggest_break: {
			name: "suggest_break",
			label: "suggest_break",
			description:
				'Offer the learner a short break. Call it when a [Session note] says a break is due, in that same turn, or whenever the learner asks for one (requestedBy "learner"). First say it in one line of ordinary prose, then call this tool and end your turn. With oneMoreQuestion true, your line offers the one question that would close the current node first. The learner chooses in the app; don\'t ask them again in prose.',
			parameters: suggestBreakInput,
			execute: serverExecute("suggest_break", suggestBreakInput, async (input) => {
				const refuse = (text: string) => ({ text, details: { ok: false } });
				if (input.oneMoreQuestion !== undefined && input.requestedBy !== "window") return refuse(R5);
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };

				const settings = ctx.breaks();
				const state = breakState(
					record.messages,
					record.sideChats,
					breakTimings(settings),
					settings.enabled,
					ctx.now(),
				);
				if (input.requestedBy === "window") {
					if (state.window === null) return refuse(R1);
					if (teachTags(record.messages).length === 0) return refuse(R2);
					if (hasUnresolvedQuestion(record.messages)) return refuse(R3);
				}
				if (state.latest?.outcome === "pending" || state.latest?.outcome === "taken") return refuse(R4);
				return { text: OK1, details: { ok: true, requestedBy: input.requestedBy, ...(input.oneMoreQuestion !== undefined ? { oneMoreQuestion: input.oneMoreQuestion } : {}) } };
			}),
		},
	};
}
