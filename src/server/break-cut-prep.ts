/**
 * PREPARE THE UNIT CUT DURING A BREAK (plan 002 part 5): a break taken at a
 * unit end builds the finished unit's lesson-record judgment while the learner
 * is away; the cut at the move uses it when its span matches.
 */

import { currentUnitIndex, newestLessonRecord, atUnitEnd } from "../core/units.ts";
import { runningUnit, type CompactionDeps } from "./compaction.ts";
import { computeLessonJudgment, preparedJudgments, spanKeyOf } from "./unit-cut.ts";

export async function prepareUnitCutDuringBreak(deps: CompactionDeps, chatId: string): Promise<void> {
	if (runningUnit(chatId) !== undefined) return;
	try {
		const record = deps.chatStore.getChat(chatId);
		const tree = record?.tree;
		if (!record || !tree?.units || !atUnitEnd(tree, record.messages)) return;
		const messages = record.messages;
		const cur = currentUnitIndex(tree, messages)! + 1;
		const k = messages.length;
		const previousRecord = newestLessonRecord(messages);
		const s = previousRecord ? Math.max(0, messages.findIndex((m) => m.id === previousRecord.details.firstKeptMessageId)) : 0;
		const computed = await computeLessonJudgment(deps, chatId, messages, tree, cur, k);
		if (computed === "failed") return;
		preparedJudgments.set(chatId, { spanKey: spanKeyOf(messages, s, k, previousRecord?.id), ...computed });
	} catch (err) {
		console.error(`[chat ${chatId}] unit cut preparation failed:`, err);
	}
}
