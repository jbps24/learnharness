import { BOOK_ROUTE_CAP, fileCategory, fileMaterialKind, type BookRoute, type CourseMaterial, type ReferenceSection } from "./contracts/course.ts";
import type { PlanTree } from "./contracts/plan.ts";

/** Plan 020 part 3, owner-confirmed: instructions for reading a reference book section for an overview node. */
export const BOOK_ROUTE_INSTRUCTIONS =
	'You read sections of a reference book for one plan node of a learning application. The course\'s own material for this node is an overview: it sets what is learned and shows the results, but not how the course gets there. The book is what the course was built from, so its derivation is how the learner has to work this node. Write down the book\'s route for this node: the derivation or procedure step by step, with its assumptions and intermediate results, in the book\'s order, so a tutor can teach and grade by it without the book. Cover what the overview route below shows; leave out the book\'s further topics. Where the overview names the same quantity, use the overview\'s notation and say where the book\'s differs. Cite the book\'s printed pages, e.g. (p. 187). Never fill a gap from your own knowledge. Return ONE JSON object and nothing else: {"pages":string,"method":string}, the method at most 2,500 characters. If these pages don\'t cover the node, return {"pages":"","method":""}.';

export interface BookRouteTarget {
	nodeId: string;
	path: string;
	sectionIds: string[];
}

export interface BookRouteTargetsResult {
	targets: BookRouteTarget[];
	material: CourseMaterial;
}

export interface BookRoutePromptInput {
	path: string;
	node: { id: string; title: string; summary?: string };
	overviewMethods: readonly { path: string; pages?: string; method: string }[];
	pagesSpec?: string;
	sectionsText?: string;
}

export type ParseBookRouteResult =
	| { ok: true; kind: "covered"; pages: string; method: string }
	| { ok: true; kind: "not-covered" }
	| { ok: false; problems: string[] };

export interface BookRouteWorkerInput {
	chatId: string;
	nodeId: string;
	nodeTitle: string;
	nodeSummary?: string;
	path: string;
	sectionIds: string[];
	sections: ReferenceSection[];
	referenceFrom: "outline" | "contents" | "headings";
	overviewMethods: Array<{ path: string; pages?: string; method: string }>;
	abortSignal: AbortSignal;
}

export type BookRouteWorkerResult =
	| { ok: true; pages: string; method: string }
	| { ok: false; error: string };

export type BookRouteWorker = (input: BookRouteWorkerInput) => Promise<BookRouteWorkerResult>;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The binding Overview routes of a node (plan 020 part 3): what the book route is read against. */
export function overviewMethodsOf(
	material: CourseMaterial,
	nodeId: string,
): Array<{ path: string; pages?: string; method: string }> {
	const overview = new Set(
		material.files
			.filter((f) => f.binding && fileCategory(f) === "material" && fileMaterialKind(f) === "overview")
			.map((f) => f.path),
	);
	return material.methods
		.filter((m) => m.nodeId === nodeId && overview.has(m.path))
		.map((m) => ({ path: m.path, ...(m.pages !== undefined ? { pages: m.pages } : {}), method: m.method }));
}

/**
 * Plan 020 part 3: the book routes still to read and the material with stale
 * routes removed. A node is due when it has a method from a binding material
 * file, every such file is Overview, and a binding reference file points at
 * it with at least one section. A stored route (failed ones too) satisfies a
 * target when its path and section ids match the pointer's.
 */
export function bookRouteTargets(material: CourseMaterial, tree: PlanTree | undefined): BookRouteTargetsResult {
	const nodeIds = new Set((tree?.nodes ?? []).map((n) => n.id));
	const pointers = material.referencePointers ?? [];
	const stored = material.bookRoutes ?? [];
	const kept = stored.filter((route) =>
		nodeIds.has(route.nodeId) &&
		pointers.some((p) => p.nodeId === route.nodeId && p.path === route.path && sameIds(route.sectionIds, p.sectionIds)),
	);
	const pruned = kept.length === stored.length ? material : { ...material, bookRoutes: kept };

	const binding = new Map(material.files.filter((f) => f.binding).map((f) => [f.path, f]));
	const targets: BookRouteTarget[] = [];
	for (const node of tree?.nodes ?? []) {
		const files = material.methods
			.filter((m) => m.nodeId === node.id)
			.map((m) => binding.get(m.path))
			.filter((f) => f !== undefined && fileCategory(f) === "material");
		if (files.length === 0 || files.some((f) => fileMaterialKind(f!) !== "overview")) continue;
		for (const pointer of pointers) {
			if (pointer.nodeId !== node.id || pointer.sectionIds.length === 0) continue;
			const reference = binding.get(pointer.path);
			if (!reference || fileCategory(reference) !== "reference") continue;
			if (kept.some((r) => r.nodeId === node.id && r.path === pointer.path && sameIds(r.sectionIds, pointer.sectionIds))) continue;
			targets.push({ nodeId: node.id, path: pointer.path, sectionIds: [...pointer.sectionIds] });
		}
	}
	return { targets, material: pruned };
}

/** Retry on a reference file: its failed book routes are read again. */
export function clearFailedBookRoutes(material: CourseMaterial, path: string): CourseMaterial {
	if (!material.bookRoutes) return material;
	return { ...material, bookRoutes: material.bookRoutes.filter((r: BookRoute) => !(r.path === path && r.error !== undefined)) };
}

export function buildBookRoutePrompt(input: BookRoutePromptInput): string {
	const lines = [
		`Reference file: ${input.path}`,
		"",
		"Plan node:",
		`- id: ${input.node.id}`,
		`  title: ${input.node.title}`,
	];
	if (input.node.summary) lines.push(`  summary: ${input.node.summary}`);
	lines.push("", "Overview route(s) of this node:");
	for (const m of input.overviewMethods) {
		lines.push(`- ${m.path}${m.pages ? ` (${m.pages})` : ""}: ${m.method}`);
	}
	if (input.pagesSpec) lines.push("", `Pointed sections, pages ${input.pagesSpec}.`);
	if (input.sectionsText) lines.push("", "Pointed sections:", input.sectionsText);
	lines.push("", "Return the JSON object.");
	return lines.join("\n");
}

function stripFence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return fenced ? fenced[1]! : trimmed;
}

export function parseBookRoute(raw: string): ParseBookRouteResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch {
		return { ok: false, problems: ["the output is not valid JSON"] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, problems: ['the output must be one JSON object {"pages":string,"method":string}'] };
	}
	const { pages, method } = parsed as { pages?: unknown; method?: unknown };
	if (typeof pages !== "string" || typeof method !== "string") {
		return { ok: false, problems: ['"pages" and "method" must both be strings'] };
	}
	if (pages.trim() === "" && method.trim() === "") return { ok: true, kind: "not-covered" };
	if (method.trim() === "") return { ok: false, problems: ['"method" is empty; return {"pages":"","method":""} if the pages do not cover the node'] };
	if (method.length > BOOK_ROUTE_CAP) {
		return { ok: false, problems: [`"method" is ${method.length} characters; it may be at most ${BOOK_ROUTE_CAP}`] };
	}
	return { ok: true, kind: "covered", pages: pages.trim(), method: method.trim() };
}
