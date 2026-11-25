export type LiveProcess = { readonly owner: symbol; readonly sessionId: string | undefined; toolCallIds: string[]; kill(): void };

// A process is held after a finished turn and while a tool call waits (a question tool holds its
// call until the learner answers). Past this, the process is killed and the next request starts a
// fresh one with a full replay. It stays under MCP_TOOL_TIMEOUT so the process is killed before the
// CLI gives up on its own.
export const LIVE_PROCESS_IDLE_TIMEOUT_MS = 50 * 60_000;

/** Held processes app-wide; holding one more kills the one idle longest. */
export const MAX_LIVE_PROCESSES = 3;

/** Test seam (runner.ts's pdfModelOverride idiom). */
export const liveProcessIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

// Each live process mapped to the timer that kills it if pi never calls back. Insertion order is
// idle order: the first entry has been idle longest.
const liveProcesses = new Map<LiveProcess, NodeJS.Timeout>();

export function addLiveProcess(process: LiveProcess): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.kill();
	}, liveProcessIdleTimeoutMs.current);

	timer.unref();

	liveProcesses.set(process, timer);

	while (liveProcesses.size > MAX_LIVE_PROCESSES) {
		const [oldest] = liveProcesses.keys();
		if (!oldest) break;
		removeLiveProcess(oldest);
		oldest.kill();
	}
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcess(toolCallIds: string[], owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && hasSameIds(process.toolCallIds, toolCallIds)) return process;
	}

	return null;
}

/** The process held after a finished turn (no tool calls waiting) for this owner and session. */
export function getHeldProcess(owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && process.toolCallIds.length === 0) return process;
	}

	return null;
}

export function countLiveProcesses(owner: symbol, sessionId: string): number {
	return [...liveProcesses.keys()].filter((process) => process.owner === owner && process.sessionId === sessionId).length;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}
