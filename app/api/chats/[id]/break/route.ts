/**
 * THE BREAK ROUTE (plan 002 part 4): Take and Skip on an open break offer are
 * silent appends — no turn, no agent, no tokens. Continue is not here: it is
 * the `break-continue` chat input, because it composes a teacher turn.
 *
 * The one exception is Skip of a one-more-question offer (plan 011): it runs
 * the `break-skip-one-more` input, which appends the marker and the teacher's
 * note and starts a turn.
 *
 * Guards: 404 unknown chat, 409 while a turn runs, 400 unless the latest
 * suggestion is pending with that toolCallId.
 */
import { assertPluginQuestionInputAllowed, breakState, breakTimings, ChatInputError, emit, isOneMoreQuestionOffer, newBreakSkippedMessage, newBreakTakenMessage } from "@/src/core";
import { backgroundCompactionDeps, effectiveSettings, getChat, handleChatInput, isTurnRunning, prepareUnitCutDuringBreak, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { input?: { type?: unknown; toolCallId?: unknown } | null } | null;
	const input = body?.input;
	if (!input || (input.type !== "take" && input.type !== "skip") || typeof input.toolCallId !== "string" || !input.toolCallId) {
		return Response.json({ error: "input must be { type: \"take\" | \"skip\", toolCallId }" }, { status: 400 });
	}

	if (isTurnRunning(id)) return Response.json({ error: "A turn is running." }, { status: 409 });

	// Validate against current truth after the body await.
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
	// Take mounts the full-screen break; Continue is refused while a plugin
	// question is open, so entering the break then would trap the learner.
	try {
		assertPluginQuestionInputAllowed(chat.messages, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const { breaks } = effectiveSettings();
	const now = Date.now();
	const latest = breakState(chat.messages, chat.sideChats, breakTimings(breaks), breaks.enabled, now).latest;
	if (!latest || latest.outcome !== "pending" || latest.toolCallId !== input.toolCallId) {
		return Response.json({ error: "No break offer is open." }, { status: 400 });
	}

	// Skip of a one-more-question offer composes a teacher turn (the break-continue path).
	if (input.type === "skip" && isOneMoreQuestionOffer(chat.messages, input.toolCallId)) {
		const res = await handleChatInput(id, { type: "break-skip-one-more", toolCallId: input.toolCallId });
		if (!res.ok) return res;
		// Nobody else reads the stream; drain it so the turn finishes and persists.
		void res.arrayBuffer().catch(() => undefined);
		return Response.json({ ok: true });
	}

	const marker = input.type === "take"
		? newBreakTakenMessage(input.toolCallId, breaks.lengthMinutes, now)
		: newBreakSkippedMessage(input.toolCallId, now);
	stores.chatStore.saveMessages(id, [...chat.messages, marker]);
	emit("record-changed", { chatId: id });
	if (input.type === "take") {
		const deps = backgroundCompactionDeps(id);
		if (deps) void prepareUnitCutDuringBreak(deps, id);
	}
	return Response.json({ ok: true });
}
