import type { JsonObject } from "@earendil-works/pi-ai";

// The replay writes past turns as `[tool call name] {json}`, `[tool result name]`, `[assistant]` and
// `[user]` lines. A model that continues the replay writes them as plain text; only these headers at
// line start count, so inline mentions, indented lines, `[Image: …]` and `[!IMPORTANT]` stay.
const REPLAY_LINE = /^\[(?:tool call [^\]\s]+|tool result [^\]\n]+|assistant|user)\]/m;
const TOOL_CALL_HEADER = /^\[tool call ([^\]\s]+)\]/m;

/** Cuts from the first replay-format line to the end: what follows one is invented replay too. */
export function stripReplayLines(text: string): { kept: string; cut: string } {
	const index = text.search(REPLAY_LINE);
	if (index === -1) return { kept: text, cut: "" };

	return { kept: text.slice(0, index).trimEnd(), cut: text.slice(index) };
}

/** The first text call in the cut part, if it names a declared tool and carries a JSON object. */
export function salvageToolCall(cut: string, toolNames: ReadonlySet<string>): { name: string; arguments: JsonObject } | null {
	const header = TOOL_CALL_HEADER.exec(cut);
	const name = header?.[1];
	if (!header || !name || !toolNames.has(name)) return null;

	const rest = cut.slice(header.index + header[0].length);
	const next = rest.search(REPLAY_LINE);
	const body = (next === -1 ? rest : rest.slice(0, next)).trim();
	if (!body.startsWith("{")) return null;

	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return { name, arguments: parsed as JsonObject };
	} catch {
		return null;
	}
}
