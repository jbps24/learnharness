/** Find matching (plan 003 part 4): case-insensitive, accent-insensitive
 *  substring search over one block of text, reported as original UTF-16
 *  offsets. Normalisation is per character (NFD, combining marks dropped,
 *  ß/ẞ → ss, lower case); every whitespace run counts as one space. */
export interface SessionTextMatch {
	start: number;
	end: number;
}

interface Normalized {
	text: string;
	/** Per normalised UTF-16 index: the original range it came from. */
	starts: number[];
	ends: number[];
}

const COMBINING_MARKS = /\p{M}/gu;
const WHITESPACE = /^\s$/u;

function normalize(source: string): Normalized {
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let at = 0;
	for (const ch of source) {
		const start = at;
		const end = at + ch.length;
		at = end;
		if (WHITESPACE.test(ch)) {
			if (text.endsWith(" ")) {
				ends[ends.length - 1] = end;
			} else {
				text += " ";
				starts.push(start);
				ends.push(end);
			}
			continue;
		}
		const norm = ch.normalize("NFD").replace(COMBINING_MARKS, "").replace(/[ßẞ]/g, "ss").toLowerCase();
		if (norm === "") {
			// A lone combining mark belongs to the character before it.
			if (ends.length > 0) ends[ends.length - 1] = end;
			continue;
		}
		for (let i = 0; i < norm.length; i++) {
			starts.push(start);
			ends.push(end);
		}
		text += norm;
	}
	return { text, starts, ends };
}

export function findSessionTextMatches(text: string, query: string): SessionTextMatch[] {
	const needle = normalize(query).text.trim();
	if (needle === "" || text === "") return [];
	const hay = normalize(text);
	const matches: SessionTextMatch[] = [];
	let from = 0;
	for (;;) {
		const found = hay.text.indexOf(needle, from);
		if (found < 0) break;
		const last = found + needle.length - 1;
		matches.push({ start: hay.starts[found]!, end: hay.ends[last]! });
		from = found + needle.length;
	}
	return matches;
}
