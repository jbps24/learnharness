import type { SideChatThread } from "./contracts/chat.ts";
import {
	hasProbeDone,
	nativeInputCause,
	newBreakNoteMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

export interface BreakTimings {
	intervalMs: number;
	lengthMs: number;
	resetMs: number;
	leadMs: number;
	escalateMs: number;
	reofferMs: number;
}

const MINUTE_MS = 60_000;

/** The break window's derived timings: lead = interval/9, escalate = reoffer
 *  = interval×4/9, each rounded to whole minutes. */
export function breakTimings(s: { intervalMinutes: number; lengthMinutes: number; resetMinutes: number }): BreakTimings {
	const escalateMinutes = Math.round((s.intervalMinutes * 4) / 9);
	return {
		intervalMs: s.intervalMinutes * MINUTE_MS,
		lengthMs: s.lengthMinutes * MINUTE_MS,
		resetMs: s.resetMinutes * MINUTE_MS,
		leadMs: Math.round(s.intervalMinutes / 9) * MINUTE_MS,
		escalateMs: escalateMinutes * MINUTE_MS,
		reofferMs: escalateMinutes * MINUTE_MS,
	};
}

export interface LearningClock {
	learningMs: number;
	startedAt: number | null;
	awayMs: number | null;
}

export interface BreakSuggestion {
	toolCallId: string;
	requestedBy: "window" | "learner";
	outcome: "pending" | "taken" | "skipped" | "ended";
	takenAt?: number;
	lengthMinutes?: number;
	breakMs?: number;
}

export interface BreakState {
	window: { id: string; openedAtMs: number; escalated: boolean; noteInContext: boolean } | null;
	latest: BreakSuggestion | null;
	skipsInRow: number;
	nextOpenAtMs: number | null;
}

export function windowNoteText(timings: BreakTimings): string {
	const interval = Math.round(timings.intervalMs / MINUTE_MS);
	return `[Session note] The learner has been learning for about ${interval} minutes. At the next closed point, suggest a short break: say so in one line, then call suggest_break with requestedBy "window" and end your turn. A closed point is a node end (its check answered correctly, no repair pending) or, better, a unit end; if the current node is the last of its unit, wait for the unit end. Never break mid-step or during a repair.`;
}

export const ESCALATION_NOTE_TEXT =
	"[Session note] A break is overdue. Suggest it at the very next closed point, a node end included; don't hold out for the unit end.";

export function awayNoteText(awayMs: number): string {
	return `[Session note] The learner is back after ${formatAway(awayMs)} away. If it helps, re-orient them in one line (where we are, what's next), then continue.`;
}

/** "2 h 14 min", "18 min". */
export function formatAway(ms: number): string {
	const totalMinutes = Math.floor(ms / MINUTE_MS);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const restHours = hours % 24;
		return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
	}
	if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
	return `${minutes} min`;
}

const isBreakMarker = (m: LhMessage): boolean =>
	m.role === "custom" && (m.customType === "break-note" || m.customType === "break-taken" || m.customType === "break-skipped" || m.customType === "break-ended");

const causeAt = (messages: readonly LhMessage[], i: number) => {
	const m = messages[i]!;
	return nativeInputCause(m, m.role === "toolResult" ? messages.slice(0, i) : messages);
};

const sideUserTimes = (sideChats: readonly SideChatThread[] | undefined): number[] =>
	(sideChats ?? []).flatMap((t) => t.messages.filter((m) => m.role === "user").map((m) => Date.parse(m.at)));

export function learnerActivityTimes(
	messages: readonly LhMessage[],
	sideChats: readonly SideChatThread[] | undefined,
): number[] {
	const times = messages.flatMap((m, i) => (causeAt(messages, i) === "learner" ? [m.timestamp] : []));
	return [...times, ...sideUserTimes(sideChats)].sort((a, b) => a - b);
}

interface ClockVisit {
	/** The main-transcript message just processed, or null for a side-chat action. */
	index: number | null;
	time: number;
	reset: boolean;
	/** The clock start after processing (null before any learner action). */
	startedAt: number | null;
}

/** Replays the transcript for the learning clock; `visit` sees every message
 *  and side-chat action after it was applied. Returns the clock state at the end. */
function replayClock(
	messages: readonly LhMessage[],
	sideChats: readonly SideChatThread[] | undefined,
	resetMs: number,
	visit?: (v: ClockVisit) => void,
): { startedAt: number | null; activityEnd: number | null; trigger: "learner" | "automatic" | null } {
	let startedAt: number | null = null;
	let activityEnd: number | null = null;
	let trigger: "learner" | "automatic" | null = null;
	const side = sideUserTimes(sideChats).sort((a, b) => a - b);
	let sideAt = 0;

	const act = (time: number, forceReset: boolean): boolean => {
		const reset = forceReset || startedAt === null || (activityEnd !== null && time - activityEnd >= resetMs);
		if (reset) startedAt = time;
		activityEnd = forceReset || activityEnd === null ? time : Math.max(activityEnd, time);
		return reset;
	};
	const drainSide = (until: number): void => {
		while (sideAt < side.length && side[sideAt]! < until) {
			const time = side[sideAt++]!;
			const reset = act(time, false);
			visit?.({ index: null, time, reset, startedAt });
		}
	};

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		drainSide(m.timestamp);
		const cause = causeAt(messages, i);
		let reset = false;
		if (m.role === "custom" && m.customType === "break-ended") {
			act(m.timestamp, true);
			reset = true;
			trigger = "learner";
		} else if (cause === "learner") {
			reset = act(m.timestamp, false);
			trigger = "learner";
		} else if (cause === "automatic") {
			trigger = "automatic";
		} else if ((m.role === "assistant" || m.role === "toolResult") && trigger === "learner") {
			const end = m.timestamp + ((m as { durationMs?: number }).durationMs ?? 0);
			activityEnd = Math.max(activityEnd ?? end, end);
		}
		visit?.({ index: i, time: m.timestamp, reset, startedAt });
	}
	drainSide(Number.POSITIVE_INFINITY);
	return { startedAt, activityEnd, trigger };
}

export function learningClock(
	messages: readonly LhMessage[],
	sideChats: readonly SideChatThread[] | undefined,
	timings: BreakTimings,
	now: number,
	opts?: { turnRunning?: boolean },
): LearningClock {
	const replayed = replayClock(messages, sideChats, timings.resetMs);
	const { startedAt } = replayed;
	let { activityEnd } = replayed;
	if (opts?.turnRunning && replayed.trigger === "learner" && activityEnd !== null) activityEnd = Math.max(activityEnd, now);
	if (activityEnd !== null && now - activityEnd >= timings.resetMs) {
		return { learningMs: 0, startedAt: now, awayMs: now - activityEnd };
	}
	return { learningMs: startedAt === null ? 0 : now - startedAt, startedAt, awayMs: null };
}

const ID_OF = (m: LhMarkerMessage, key: string): string | undefined =>
	(m.details as Record<string, unknown> | null)?.[key] as string | undefined;

export function breakState(
	messages: readonly LhMessage[],
	sideChats: readonly SideChatThread[] | undefined,
	timings: BreakTimings,
	enabled: boolean,
	now: number,
): BreakState {
	const firstOpenMs = timings.intervalMs - timings.leadMs;
	let window: { id: string; openedAtMs: number; escalated: boolean; noteIdx: number } | null = null;
	let latest: BreakSuggestion | null = null;
	let skipsInRow = 0;
	let nextOpenAtMs: number | null = firstOpenMs;
	const requestedBy = new Map<string, "window" | "learner">();

	const learningAt = (time: number, startedAt: number | null) => (startedAt === null ? 0 : time - startedAt);

	const { activityEnd } = replayClock(messages, sideChats, timings.resetMs, (v) => {
		const m = v.index === null ? null : messages[v.index]!;
		const learning = learningAt(v.time, v.startedAt);
		if (m) {
			if (m.role === "assistant") {
				for (const block of m.content) {
					if (block.type === "toolCall" && block.name === "suggest_break") {
						requestedBy.set(block.id, (block.arguments as { requestedBy?: string } | null)?.requestedBy === "window" ? "window" : "learner");
					}
				}
			} else if (m.role === "toolResult") {
				const ok = m.toolName === "suggest_break" && !m.isError && (m.details as { ok?: boolean } | null)?.ok !== false;
				if (ok) {
					window = null;
					latest = { toolCallId: m.toolCallId, requestedBy: requestedBy.get(m.toolCallId) ?? "learner", outcome: "pending" };
				}
			} else if (m.role === "custom") {
				if (m.customType === "break-note") {
					const kind = ID_OF(m, "kind");
					const windowId = ID_OF(m, "windowId");
					if (kind === "window") {
						if (window && window.id === windowId) window.noteIdx = v.index!;
						else window = { id: windowId ?? m.id, openedAtMs: learning, escalated: false, noteIdx: v.index! };
					} else if (kind === "escalation" && window && window.id === windowId) {
						window.escalated = true;
					}
				} else if (latest && ID_OF(m, "toolCallId") === latest.toolCallId) {
					if (m.customType === "break-taken" && latest.outcome === "pending") {
						const lengthMinutes = (m.details as { lengthMinutes?: number } | null)?.lengthMinutes;
						latest = { ...latest, outcome: "taken", takenAt: m.timestamp, lengthMinutes };
					} else if (m.customType === "break-skipped" && latest.outcome === "pending") {
						latest = { ...latest, outcome: "skipped" };
						if (latest.requestedBy === "window") {
							skipsInRow++;
							nextOpenAtMs = skipsInRow >= 2 ? null : learning + timings.reofferMs;
						}
					} else if (m.customType === "break-ended") {
						const breakMs = (m.details as { breakMs?: number } | null)?.breakMs;
						latest = { ...latest, outcome: "ended", breakMs };
					}
				}
			}
			// A main-transcript learner action that is not a break marker declines a pending suggestion.
			if (latest && (latest as BreakSuggestion).outcome === "pending" && !isBreakMarker(m) && causeAt(messages, v.index!) === "learner") {
				const pending = latest as BreakSuggestion;
				latest = { ...pending, outcome: "skipped" };
				if (pending.requestedBy === "window") {
					skipsInRow++;
					nextOpenAtMs = skipsInRow >= 2 ? null : learning + timings.reofferMs;
				}
			}
		}
		if (v.reset) {
			window = null;
			skipsInRow = 0;
			nextOpenAtMs = firstOpenMs;
		}
	});

	if (activityEnd !== null && now - activityEnd >= timings.resetMs) {
		window = null;
		skipsInRow = 0;
		nextOpenAtMs = firstOpenMs;
		if (latest && (latest as BreakSuggestion).outcome === "pending") {
			latest = { ...(latest as BreakSuggestion), outcome: "skipped" };
		}
	}

	const contextStart = Math.max(keptIndex(messages, "lesson-record"), keptIndex(messages, "compaction"));
	const open = window as { id: string; openedAtMs: number; escalated: boolean; noteIdx: number } | null;
	return {
		window: open
			? { id: open.id, openedAtMs: open.openedAtMs, escalated: open.escalated, noteInContext: open.noteIdx >= contextStart }
			: null,
		latest,
		skipsInRow,
		nextOpenAtMs: enabled ? nextOpenAtMs : null,
	};
}

/** An offer still open when the learner is away shows as skipped. */
export function dividerState(
	state: "offered" | "taken" | "skipped" | "ended",
	away: boolean,
): "offered" | "taken" | "skipped" | "ended" {
	return state === "offered" && away ? "skipped" : state;
}

/** Index of the newest `customType` marker's first kept message (0 when none). */
function keptIndex(messages: readonly LhMessage[], customType: "lesson-record" | "compaction"): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "custom" || m.customType !== customType) continue;
		const keptId = (m.details as { firstKeptMessageId?: string } | null)?.firstKeptMessageId;
		return Math.max(0, messages.findIndex((x) => x.id === keptId));
	}
	return 0;
}

export function breakNotesFor(
	messages: readonly LhMessage[],
	sideChats: readonly SideChatThread[] | undefined,
	timings: BreakTimings,
	enabled: boolean,
	now: number,
): LhMarkerMessage[] {
	const clock = learningClock(messages, sideChats, timings, now);
	const state = breakState(messages, sideChats, timings, enabled, now);
	const notes: LhMarkerMessage[] = [];
	if (clock.awayMs !== null && state.latest?.outcome !== "taken") {
		notes.push(newBreakNoteMessage("away", awayNoteText(clock.awayMs), undefined, now));
	}
	if (!enabled) return notes;
	if (
		hasProbeDone(messages) &&
		state.window === null &&
		state.latest?.outcome !== "pending" &&
		state.latest?.outcome !== "taken" &&
		state.nextOpenAtMs !== null &&
		clock.learningMs >= state.nextOpenAtMs
	) {
		notes.push(newBreakNoteMessage("window", windowNoteText(timings), undefined, now));
	}
	if (state.window) {
		if (!state.window.noteInContext) {
			notes.push(newBreakNoteMessage("window", windowNoteText(timings), state.window.id, now));
		}
		if (!state.window.escalated && clock.learningMs >= state.window.openedAtMs + timings.escalateMs) {
			notes.push(newBreakNoteMessage("escalation", ESCALATION_NOTE_TEXT, state.window.id, now));
		}
	}
	return notes;
}

export function breakCountdown(
	takenAt: number,
	lengthMinutes: number,
	now: number,
): { label: string; over: boolean; progress: number } {
	const totalMs = lengthMinutes * MINUTE_MS;
	const elapsed = Math.max(0, now - takenAt);
	const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const overMs = elapsed - totalMs;
	const over = overMs >= 1000;
	return {
		label: over ? `+${clock(Math.floor(overMs / 1000))}` : clock(Math.max(0, Math.ceil((totalMs - elapsed) / 1000))),
		over,
		progress: totalMs > 0 ? Math.min(1, elapsed / totalMs) : 1,
	};
}

export function learningMinutes(clock: LearningClock): number {
	return clock.awayMs !== null ? 0 : Math.floor(clock.learningMs / MINUTE_MS);
}
