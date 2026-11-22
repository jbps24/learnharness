import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSessionTextMatches } from "../src/core/find-match.ts";
import {
	findSessionTextMatches as sessionFindMatches,
	stepSessionMatch,
} from "../src/core/session-find.ts";

describe("findSessionTextMatches", () => {
	// plan 003 part 4: an empty query matches nothing; whitespace-only query becomes empty after ignoring leading/trailing whitespace
	it("returns no matches for empty query, whitespace-only query, or empty text", () => {
		assert.deepEqual(findSessionTextMatches("hello world", ""), []);
		assert.deepEqual(findSessionTextMatches("hello world", "   \n\t  "), []);
		assert.deepEqual(findSessionTextMatches("", "hello"), []);
	});

	// plan 003 part 4: leading and trailing query whitespace is ignored
	it("ignores leading and trailing whitespace in the query", () => {
		assert.deepEqual(findSessionTextMatches("hello world", "  world  "), [{ start: 6, end: 11 }]);
	});

	// plan 003 part 4: case-insensitive, accents ignored (uber finds über, Über, uber; über finds uber; e finds é)
	it("matches case-insensitively and ignores accents", () => {
		assert.deepEqual(findSessionTextMatches("über Über uber", "uber"), [
			{ start: 0, end: 4 },
			{ start: 5, end: 9 },
			{ start: 10, end: 14 },
		]);
		assert.deepEqual(findSessionTextMatches("uber", "über"), [{ start: 0, end: 4 }]);
		assert.deepEqual(findSessionTextMatches("café", "e"), [{ start: 3, end: 4 }]);
	});

	// plan 003 part 4: Unicode NFD + drop combining marks maps back to original UTF-16 range
	it("maps decomposed combining marks back to their full original UTF-16 range", () => {
		assert.deepEqual(findSessionTextMatches("u\u0308ber", "uber"), [{ start: 0, end: 5 }]);
	});

	// plan 003 part 4: no ae/oe/ue expansion
	it("does not expand ae/oe/ue to umlauts", () => {
		assert.deepEqual(findSessionTextMatches("über", "ueber"), []);
		assert.deepEqual(findSessionTextMatches("äöü", "ae"), []);
	});

	// plan 003 part 4: ß/ẞ -> ss (strasse finds Straße and STRAẞE; straße finds Strasse)
	it("normalizes ß and ẞ to ss in both text and query", () => {
		assert.deepEqual(findSessionTextMatches("Straße", "strasse"), [{ start: 0, end: 6 }]);
		assert.deepEqual(findSessionTextMatches("STRAẞE", "strasse"), [{ start: 0, end: 6 }]);
		assert.deepEqual(findSessionTextMatches("Strasse", "straße"), [{ start: 0, end: 7 }]);
	});

	// plan 003 part 4: substring anywhere in a word (ableit finds Produktableitung)
	it("matches substrings anywhere inside a word", () => {
		assert.deepEqual(findSessionTextMatches("Produktableitung", "ableit"), [{ start: 7, end: 13 }]);
	});

	// plan 003 part 4: multi-word query is an exact phrase (kette regel does not find Kettenregel)
	it("treats a multi-word query as an exact phrase", () => {
		assert.deepEqual(findSessionTextMatches("Kettenregel", "kette regel"), []);
	});

	// plan 003 part 4: every run of whitespace in text and query counts as one space (zwei  wörter finds zwei\nWörter)
	it("collapses whitespace runs across spaces, tabs, and line breaks", () => {
		assert.deepEqual(findSessionTextMatches("zwei\nWörter", "zwei  wörter"), [{ start: 0, end: 11 }]);
		assert.deepEqual(findSessionTextMatches("a   \t\n  b", "a b"), [{ start: 0, end: 9 }]);
	});

	// plan 003 part 4: matches are non-overlapping, scanned left to right
	it("returns non-overlapping matches scanned left to right", () => {
		assert.deepEqual(findSessionTextMatches("aaa", "aa"), [{ start: 0, end: 2 }]);
		assert.deepEqual(findSessionTextMatches("ababa", "aba"), [{ start: 0, end: 3 }]);
	});

	// plan 003 part 4: original { start, end } UTF-16 offsets preserved after surrogate pairs
	it("preserves original UTF-16 offsets after surrogate pairs", () => {
		assert.deepEqual(findSessionTextMatches("😀 über", "uber"), [{ start: 3, end: 7 }]);
	});
});

describe("session-find compatibility", () => {
	// plan 003 part 4: session-find.ts keeps exporting findSessionTextMatches with new semantics and stepSessionMatch unchanged
	it("re-exports findSessionTextMatches with new semantics and keeps stepSessionMatch unchanged", () => {
		assert.deepEqual(sessionFindMatches("Straße", "strasse"), [{ start: 0, end: 6 }]);
		assert.equal(stepSessionMatch(0, 3, -1), 2);
		assert.equal(stepSessionMatch(2, 3, 1), 0);
		assert.equal(stepSessionMatch(0, 0, 1), -1);
	});
});
