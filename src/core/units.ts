import type { LessonRecordDetails } from "./contracts/chat.ts";
import { derivePlanStatusesLh, type PlanTree } from "./contracts/plan.ts";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation } from "./plugin-questions.ts";

export interface TeachTag {
	nodeId: string;
	messageId: string;
	messageIndex: number;
}

/** Every teach-tagged quiz/explain call (built-in or plugin "posed" teach
 *  variant) in transcript order — including nodeIds no longer in the tree. */
export function teachTags(messages: readonly LhMessage[]): TeachTag[] {
	const tags: TeachTag[] = [];
	messages.forEach((m, messageIndex) => {
		if ((m as { role?: string }).role !== "assistant") return;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		for (const [contentIndex, block] of (content as Array<{ type?: string; name?: string; arguments?: unknown }>).entries()) {
			const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
			if (block.type !== "toolCall") continue;
			if (annotation.status !== "absent" ? annotation.status !== "posed" || annotation.snapshot.variant !== "teach" : block.name !== "quiz" && block.name !== "explain") continue;
			const input = annotation.status === "posed" ? annotation.snapshot.input : block.arguments;
			const nodeId = (input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string") continue;
			tags.push({ nodeId, messageId: (m as { id?: string }).id ?? "", messageIndex });
		}
	});
	return tags;
}

export function unitIndexOf(tree: PlanTree, nodeId: string): number | null {
	if (!tree.units) return null;
	const index = tree.units.findIndex((u) => u.nodeIds.includes(nodeId));
	return index < 0 ? null : index;
}

/** null without units; otherwise the furthest unit any teach tag (whose node is in the tree) reached; 0 before any. */
export function currentUnitIndex(tree: PlanTree, messages: readonly LhMessage[]): number | null {
	if (!tree.units) return null;
	let max = 0;
	for (const tag of teachTags(messages)) {
		const index = unitIndexOf(tree, tag.nodeId);
		if (index !== null && index > max) max = index;
	}
	return max;
}

export function newestLessonRecord(
	messages: readonly LhMessage[],
): (LhMarkerMessage & { details: LessonRecordDetails }) | null {
	const ids = new Set(messages.map((m) => (m as { id?: string }).id));
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "custom" || m.customType !== "lesson-record") continue;
		const details = m.details as LessonRecordDetails | undefined;
		if (details && ids.has(details.firstKeptMessageId)) return m as LhMarkerMessage & { details: LessonRecordDetails };
	}
	return null;
}

export function finishedUnitIds(messages: readonly LhMessage[]): string[] {
	return newestLessonRecord(messages)?.details.finishedUnitIds ?? [];
}

export function unitCutDue(tree: PlanTree, messages: readonly LhMessage[]): boolean {
	const cur = currentUnitIndex(tree, messages);
	return cur !== null && cur > finishedUnitIds(messages).length;
}

/** True when the tree has units, a next unit exists, and every node of the current unit is visited or current. */
export function atUnitEnd(tree: PlanTree, messages: readonly LhMessage[]): boolean {
	const cur = currentUnitIndex(tree, messages);
	if (cur === null || !tree.units || cur + 1 >= tree.units.length) return false;
	const statuses = derivePlanStatusesLh(tree, messages);
	return tree.units[cur]!.nodeIds.every((id) => statuses.current === id || statuses.visited.has(id));
}
