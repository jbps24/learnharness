import { REFERENCE_SECTIONS_CAP, type ReferenceSection } from "./contracts/course.ts";

/** Owner-confirmed (plan 012 part 2): the pdf-reader task for a PDF without an outline. */
export const REFERENCE_TOC_TASK =
	'Find this document\'s table of contents (usually within the first 30 pages). Return ONE JSON object: {"sections":[{"title":string,"level":1|2|3,"startPage":number}]}, with startPage as the PDF page index the pdf tools use — locate at least one section heading to find the offset between printed and PDF page numbers. Leave out front matter and the index.';

export interface OutlineInputItem {
	title: string;
	page: number | null;
	items?: readonly OutlineInputItem[];
}

export type ParseContentsTocResult =
	| { ok: true; sections: ReferenceSection[] }
	| { ok: false; problems: string[] };

interface RawSection {
	title: string;
	level: number;
	startPage: number;
}

/** endPage = next entry at the same or a higher level − 1 (at least startPage), the last = lastPage. */
function withEndPages(
	raw: readonly RawSection[],
	lastPage: number,
	pageLabels?: readonly (string | null)[] | null,
): ReferenceSection[] {
	return raw.slice(0, REFERENCE_SECTIONS_CAP).map((s, i) => {
		const next = raw.slice(i + 1).find((n) => n.level <= s.level);
		const endPage = next ? Math.max(s.startPage, next.startPage - 1) : lastPage;
		const label = pageLabels?.[s.startPage - 1];
		return {
			id: `s${i + 1}`,
			title: s.title,
			level: s.level,
			startPage: s.startPage,
			endPage,
			...(label ? { label } : {}),
		};
	});
}

/** Flatten a PDF outline (1-based pages); entries without a page in the document are dropped. */
export function outlineToSections(
	items: readonly OutlineInputItem[],
	pageCount: number,
	pageLabels?: readonly (string | null)[] | null,
): ReferenceSection[] {
	const raw: RawSection[] = [];
	const walk = (list: readonly OutlineInputItem[], level: number) => {
		for (const item of list) {
			const title = item.title.trim();
			if (title && item.page !== null && Number.isInteger(item.page) && item.page >= 1 && item.page <= pageCount) {
				raw.push({ title, level, startPage: item.page });
			}
			if (item.items) walk(item.items, level + 1);
		}
	};
	walk(items, 1);
	return withEndPages(raw, pageCount, pageLabels);
}

/** Parse and check the pdf-reader's contents JSON: pages increasing and within the document. */
export function parseContentsToc(
	raw: string,
	pageCount: number,
	pageLabels?: readonly (string | null)[] | null,
): ParseContentsTocResult {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	const body = fenced?.[1] ?? raw;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	let parsed: unknown;
	try {
		if (start < 0 || end < start) throw new Error("no JSON object");
		parsed = JSON.parse(body.slice(start, end + 1));
	} catch {
		return { ok: false, problems: ["the table of contents is not valid JSON"] };
	}
	const list = (parsed as { sections?: unknown } | null)?.sections;
	if (!Array.isArray(list) || list.length === 0) return { ok: false, problems: ["the table of contents has no sections"] };

	const problems: string[] = [];
	const sections: RawSection[] = [];
	let previous = 0;
	for (const [i, entry] of list.entries()) {
		const e = (entry ?? {}) as { title?: unknown; level?: unknown; startPage?: unknown };
		const title = typeof e.title === "string" ? e.title.trim() : "";
		const page = e.startPage;
		if (!title) {
			problems.push(`section ${i + 1} has no title`);
			continue;
		}
		if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pageCount) {
			problems.push(`section "${title}" starts outside the document (pages 1–${pageCount})`);
			continue;
		}
		if (page < previous) {
			problems.push(`section "${title}" starts before the previous section`);
			continue;
		}
		previous = page;
		const level = typeof e.level === "number" && Number.isInteger(e.level) ? Math.min(3, Math.max(1, e.level)) : 1;
		sections.push({ title, level, startPage: page });
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, sections: withEndPages(sections, pageCount, pageLabels) };
}

/** Headings of a text file; "pages" are 1-based line numbers. */
export function headingsToSections(text: string, ext: string): ReferenceSection[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const isTex = ext.toLowerCase() === ".tex";
	const texLevels: Record<string, number> = { chapter: 1, section: 2, subsection: 3 };
	const raw: RawSection[] = [];
	let inFence = false;
	for (const [i, line] of lines.entries()) {
		if (isTex) {
			const m = /^\s*\\(chapter|section|subsection)\*?(?:\[[^\]]*\])?\{(.+)\}/.exec(line);
			if (m) raw.push({ title: m[2]!.trim(), level: texLevels[m[1]!]!, startPage: i + 1 });
			continue;
		}
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
		if (m) raw.push({ title: m[2]!.trim(), level: m[1]!.length, startPage: i + 1 });
	}
	return withEndPages(raw, lines.length);
}
