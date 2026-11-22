/** Session Find (plan 003 part 4): delegates matching to find-match.ts while
 * keeping stepSessionMatch unchanged. */
export { findSessionTextMatches, type SessionTextMatch } from "./find-match.ts";

export function stepSessionMatch(index: number, count: number, direction: 1 | -1): number {
	if (!count) return -1;
	return ((index + direction) % count + count) % count;
}
