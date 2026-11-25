import type { ChatRecord } from "./contracts/chat.ts";
import { fileCategory, fileMaterialKind, type BookRoute, type CourseFile, type CourseMaterial, type PropositionMethod } from "./contracts/course.ts";
import type { GraphNode } from "./contracts/graph.ts";
import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";
import { teachTags } from "./units.ts";

/** The node being taught at a message: the latest teach tag at or before it whose node is in the tree (plan 007 part 6). */
export function nodeAtMessage(messages: readonly LhMessage[], tree: PlanTree, messageId: string): string | null {
	const at = messages.findIndex((m) => (m as { id?: string }).id === messageId);
	if (at < 0) return null;
	const inTree = new Set(tree.nodes.map((n) => n.id));
	let found: string | null = null;
	for (const tag of teachTags(messages)) {
		if (tag.messageIndex > at) break;
		if (inTree.has(tag.nodeId)) found = tag.nodeId;
	}
	return found;
}

/** The methods that count for a node: binding files only; a conflict leaves only the chosen route, or nothing while unresolved. */
function bindingMethodsAt(material: CourseMaterial, nodeId: string, binding: ReadonlySet<string>) {
	const methods = material.methods.filter((m) => m.nodeId === nodeId && binding.has(m.path));
	const conflict = material.conflicts.find(
		(c) => c.nodeId === nodeId && c.paths.filter((p) => binding.has(p)).length >= 2,
	);
	if (!conflict) return methods;
	if (conflict.chosen && binding.has(conflict.chosen) && conflict.paths.includes(conflict.chosen)) {
		return methods.filter((m) => m.path === conflict.chosen);
	}
	return [];
}

/** The stored, non-failed book routes of a node whose binding routes all come from Overview files (plan 020 part 4). */
export function bookRoutesForNode(
	material: CourseMaterial,
	nodeId: string,
	routes: readonly { path: string }[],
): BookRoute[] {
	if (routes.length === 0) return [];
	const kinds = new Map(material.files.map((f) => [f.path, f] as const));
	if (routes.some((r) => { const f = kinds.get(r.path); return !f || fileMaterialKind(f) !== "overview"; })) return [];
	const references = new Set(material.files.filter((f) => f.binding && fileCategory(f) === "reference").map((f) => f.path));
	return (material.bookRoutes ?? []).filter(
		(b) => b.nodeId === nodeId && references.has(b.path) && !b.error && b.method !== "",
	);
}

/** The snapshot a practice session takes from the lessons its picks came from (plan 007 part 6, choice 7: never refreshed). */
export function inheritCourseMaterial(
	picks: readonly GraphNode[],
	lessons: ReadonlyMap<string, ChatRecord>,
): CourseMaterial & { propositionMethods: PropositionMethod[] } {
	const files = new Map<string, CourseFile>();
	const propositionMethods: PropositionMethod[] = [];
	const propositionExamPatterns: NonNullable<CourseMaterial["propositionExamPatterns"]> = [];
	const seen = new Set<string>();
	const seenExam = new Set<string>();
	for (const pick of picks) {
		for (const point of pick.provenance) {
			const lesson = lessons.get(point.chatId);
			const material = lesson?.courseMaterial;
			if (!lesson || !material || lesson.kind === "practice" || !lesson.tree) continue;
			const binding = new Set(material.files.filter((f) => f.binding).map((f) => f.path));
			for (const f of material.files) {
				if (f.binding && !files.has(f.path)) files.set(f.path, { ...f, via: "inherited" });
			}
			const nodeId = nodeAtMessage(lesson.messages, lesson.tree, point.messageId);
			if (nodeId === null) continue;
			const routes = bindingMethodsAt(material, nodeId, binding);
			for (const m of routes) {
				const key = `${pick.id}\n${m.path}\n${m.method}`;
				if (seen.has(key)) continue;
				seen.add(key);
				propositionMethods.push({
					propositionId: pick.id,
					lessonId: lesson.id,
					nodeId,
					path: m.path,
					...(m.pages ? { pages: m.pages } : {}),
					method: m.method,
				});
			}
			for (const b of bookRoutesForNode(material, nodeId, routes)) {
				const key = `${pick.id}\nbook\n${b.path}\n${b.method}`;
				if (seen.has(key)) continue;
				seen.add(key);
				propositionMethods.push({
					propositionId: pick.id,
					lessonId: lesson.id,
					nodeId,
					role: "book",
					path: b.path,
					...(b.pages ? { pages: b.pages } : {}),
					method: b.method,
				});
			}
			const examPaths = new Set(material.files.filter((f) => f.binding && fileCategory(f) === "exam").map((f) => f.path));
			for (const p of material.examPatterns ?? []) {
				if (p.nodeId !== nodeId || !examPaths.has(p.path)) continue;
				const key = `${pick.id}\n${p.path}\n${p.source}`;
				if (seenExam.has(key)) continue;
				seenExam.add(key);
				propositionExamPatterns.push({ propositionId: pick.id, lessonId: lesson.id, ...p });
			}
		}
	}
	return { files: [...files.values()], methods: [], conflicts: [], propositionMethods, propositionExamPatterns };
}
