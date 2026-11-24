import { projectionHeads } from "./compaction.ts";
import type { CourseMaterial, NodeMethod } from "./contracts/course.ts";
import { derivePlanStatusesLh, type PlanTree } from "./contracts/plan.ts";
import {
	newCourseFilesNoteMessage,
	newCourseMethodNoteMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import { unitIndexOf } from "./units.ts";

function fileName(path: string): string {
	return path.split(/[\\/]/).pop() || path;
}

/** FNV-1a over the note text: stable, so an unchanged note is never due twice. */
function digestOf(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function source(method: NodeMethod): string {
	return method.pages ? `${fileName(method.path)}, ${method.pages}` : fileName(method.path);
}

function methodNoteText(nodeId: string, title: string, material: CourseMaterial, binding: ReadonlySet<string>): string | null {
	const methods = material.methods.filter((m) => m.nodeId === nodeId && binding.has(m.path));
	if (methods.length === 0) return null;
	const conflict = material.conflicts.find(
		(c) => c.nodeId === nodeId && c.paths.filter((p) => binding.has(p)).length >= 2,
	);
	const head = `[Course method] Node \`${nodeId}\` (${title}):`;
	if (conflict && !(conflict.chosen && binding.has(conflict.chosen) && conflict.paths.includes(conflict.chosen))) {
		const routes = conflict.paths
			.filter((p) => binding.has(p))
			.flatMap((p) => methods.filter((m) => m.path === p));
		return [
			`${head} the course files describe different routes:`,
			...routes.map((m, i) => `${String.fromCharCode(65 + i)} — ${source(m)}: ${m.method}`),
			"",
			"Before you teach or check this node, ask the learner with ask_user_question which route their course uses (one option per file), then call course_route with the node id and the chosen file's path.",
		].join("\n");
	}
	const route = conflict?.chosen ? methods.filter((m) => m.path === conflict.chosen) : methods;
	return [
		`${head} the learner's course works this as follows. Teach, check and grade exactly this route:`,
		...route.map((m) => `${m.method} (${source(m)})`),
	].join("\n");
}

/** The notes due before the next learner input of a teaching turn (plan 007 part 4). */
export function courseNotesFor(
	messages: readonly LhMessage[],
	tree: PlanTree,
	material: CourseMaterial | undefined,
): LhMarkerMessage[] {
	if (!material) return [];
	const binding = new Set(material.files.filter((f) => f.binding).map((f) => f.path));
	const paths = [...binding].sort();
	if (paths.length === 0) return [];

	const live = messages.slice(projectionHeads(messages).start);
	const notes: LhMarkerMessage[] = [];

	let newestFiles: string[] | null = null;
	for (const m of live) {
		if (m.role === "custom" && m.customType === "course-files") newestFiles = (m.details as { paths?: string[] } | null)?.paths ?? [];
	}
	if (newestFiles === null || newestFiles.length !== paths.length || newestFiles.some((p, i) => p !== paths[i])) {
		notes.push(newCourseFilesNoteMessage(paths));
	}

	const liveDigests = new Set<string>();
	for (const m of live) {
		if (m.role !== "custom" || m.customType !== "course-method") continue;
		const details = m.details as { nodeId?: string; digest?: string } | null;
		if (details) liveDigests.add(`${details.nodeId}\n${details.digest}`);
	}

	let scope = tree.nodes;
	if (tree.units) {
		const current = derivePlanStatusesLh(tree, messages).current;
		const index = (current ? unitIndexOf(tree, current) : null) ?? 0;
		const ids = new Set(tree.units[index]?.nodeIds ?? []);
		scope = tree.nodes.filter((n) => ids.has(n.id));
	}
	for (const node of scope) {
		const text = methodNoteText(node.id, node.title, material, binding);
		if (text === null) continue;
		const digest = digestOf(text);
		if (!liveDigests.has(`${node.id}\n${digest}`)) notes.push(newCourseMethodNoteMessage(node.id, text, digest));
	}
	return notes;
}

/** The notes due before the next learner input of a practice turn (plan 007 part 6). */
export function practiceCourseNotesFor(
	messages: readonly LhMessage[],
	material: CourseMaterial | undefined,
): LhMarkerMessage[] {
	if (!material) return [];
	const paths = material.files.filter((f) => f.binding).map((f) => f.path).sort();
	const propositionMethods = material.propositionMethods ?? [];
	if (paths.length === 0 && propositionMethods.length === 0) return [];

	const live = messages.slice(projectionHeads(messages).start);
	const notes: LhMarkerMessage[] = [];

	if (paths.length > 0) {
		let newestFiles: string[] | null = null;
		for (const m of live) {
			if (m.role === "custom" && m.customType === "course-files") newestFiles = (m.details as { paths?: string[] } | null)?.paths ?? [];
		}
		if (newestFiles === null || newestFiles.length !== paths.length || newestFiles.some((p, i) => p !== paths[i])) {
			notes.push(newCourseFilesNoteMessage(paths));
		}
	}

	if (propositionMethods.length > 0) {
		const text = [
			"[Course method] The learner's course solves these propositions as follows. Model solutions, hints and verdicts follow exactly these routes:",
			...propositionMethods.map(
				(m) => `- [${m.propositionId}] (from node \`${m.nodeId}\`): ${m.method} (${source(m)})`,
			),
		].join("\n");
		const digest = digestOf(text);
		const isLive = live.some(
			(m) =>
				m.role === "custom" && m.customType === "course-method"
				&& (m.details as { digest?: string } | null)?.digest === digest,
		);
		if (!isLive) notes.push(newCourseMethodNoteMessage("practice", text, digest));
	}
	return notes;
}
