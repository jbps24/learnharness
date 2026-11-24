import { nativeInputCause, type LhMessage } from "./native-messages.ts";
import type { LhViewPart } from "./view.ts";

/** Plan 003 part 1: the drawn history is render-only. The session stays whole;
 *  these pure functions pick where the transcript starts drawing. */
export const DRAWN_BUDGET = 276_480;
export const SMALL_REST = 69_120;
export const DRAW_STATUS_MIN = 82_944;

export function messageSize(message: LhMessage): number {
	return JSON.stringify(message).length;
}

function rangeSize(messages: readonly LhMessage[], from: number, to: number): number {
	let sum = 0;
	for (let i = from; i < to; i++) sum += messageSize(messages[i]!);
	return sum;
}

/** Ascending indexes where drawing may start: right after a learner input,
 *  with no tool call still waiting for its result. Index 0 is always one. */
export function drawnBoundaries(messages: readonly LhMessage[]): number[] {
	const out: number[] = [];
	if (messages.length === 0) return out;
	out.push(0);
	const open = new Set<string>();
	const seen: LhMessage[] = [];
	for (let b = 1; b < messages.length; b++) {
		const prev = messages[b - 1]!;
		// `seen` is messages[0 … b − 2], grown in place rather than sliced.
		const learner = nativeInputCause(prev, seen) === "learner";
		seen.push(prev);
		if (prev.role === "assistant") {
			for (const block of prev.content) if (block.type === "toolCall") open.add(block.id);
		} else if (prev.role === "toolResult") {
			open.delete(prev.toolCallId);
		}
		if (learner && open.size === 0) out.push(b);
	}
	return out;
}

export function drawnStartBefore(messages: readonly LhMessage[], end: number): number {
	if (end <= 0) return 0;
	const boundaries = drawnBoundaries(messages).filter((b) => b < end);
	let start = 0;
	let tail = 0;
	let next = end;
	// Walk the boundaries from the newest, accumulating the size of [b, end).
	for (let i = boundaries.length - 1; i >= 0; i--) {
		const b = boundaries[i]!;
		tail += rangeSize(messages, b, next);
		next = b;
		if (tail >= DRAWN_BUDGET) { start = b; break; }
	}
	if (start === 0) return 0;
	return rangeSize(messages, 0, start) < SMALL_REST ? 0 : start;
}

export function initialDrawnStart(messages: readonly LhMessage[]): number {
	return drawnStartBefore(messages, messages.length);
}

export function showEarlierStart(messages: readonly LhMessage[], current: number): number {
	return drawnStartBefore(messages, current);
}

export function drawnStartForTarget(messages: readonly LhMessage[], targetIndex: number, current: number): number {
	let best = 0;
	for (const b of drawnBoundaries(messages)) if (b <= targetIndex) best = b;
	return Math.min(current, best);
}

export function drawStatusNeeded(messages: readonly LhMessage[], from: number, to: number): boolean {
	return rangeSize(messages, from, to) >= DRAW_STATUS_MIN;
}

export function startId(messages: readonly LhMessage[], index: number): string | null {
	return index === 0 ? null : messages[index]!.id;
}

export function startIndex(messages: readonly LhMessage[], id: string | null): number {
	if (id === null) return 0;
	const index = messages.findIndex((m) => m.id === id);
	return index === -1 ? initialDrawnStart(messages) : index;
}

export function drawnPartFilter(messages: readonly LhMessage[], start: number): (part: LhViewPart) => boolean {
	if (start === 0) return () => true;
	const indexById = new Map<string, number>();
	messages.forEach((m, i) => indexById.set(m.id, i));
	return (part) => {
		const index = part.sourceMessageId === undefined ? undefined : indexById.get(part.sourceMessageId);
		return index === undefined || index >= start;
	};
}
