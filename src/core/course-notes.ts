import { projectionHeads } from "./compaction.ts";
import { fileCategory, type CourseFile, type CourseMaterial, type CourseUpdate, type NodeMethod } from "./contracts/course.ts";
import { derivePlanStatusesLh, type PlanTree } from "./contracts/plan.ts";
import {
	newCourseFilesNoteMessage,
	newCourseMethodNoteMessage,
	newCourseUpdateNoteMessage,
	newExamPatternNoteMessage,
	newReferenceNoteMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import { teachTags, unitIndexOf } from "./units.ts";

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

/** The open items of a file's replacement (plan 015 part 3): shared by the [Course update] note and course_update. */
export function courseUpdateOpenItems(
	update: CourseUpdate,
	messages: readonly LhMessage[],
): { changed: string[]; dropped: string[]; newSections: Array<{ title: string; pages: string }>; planOpen: boolean } {
	const at = Date.parse(update.at);
	const taught = new Set<string>();
	for (const tag of teachTags(messages)) {
		const timestamp = (messages[tag.messageIndex] as { timestamp?: number } | undefined)?.timestamp;
		if (typeof timestamp === "number" && timestamp < at) taught.add(tag.nodeId);
	}
	const nodes = update.nodes ?? [];
	const changed = nodes
		.filter((n) => n.kind === "changed" && taught.has(n.nodeId) && !update.revisited.includes(n.nodeId))
		.map((n) => n.nodeId);
	const dropped = nodes.filter((n) => n.kind === "dropped").map((n) => n.nodeId);
	const newSections = update.newSections ?? [];
	const planOpen = !update.planAsked && (dropped.length > 0 || newSections.length > 0);
	return { changed, dropped, newSections, planOpen };
}

function courseUpdateNoteText(
	file: CourseFile,
	update: CourseUpdate,
	tree: PlanTree,
	messages: readonly LhMessage[],
): string | null {
	const open = courseUpdateOpenItems(update, messages);
	if (open.changed.length === 0 && !open.planOpen) return null;
	const title = (id: string) => tree.nodes.find((n) => n.id === id)?.title;
	const label = (id: string) => (title(id) !== undefined ? `\`${id}\` (${title(id)})` : `\`${id}\``);
	const lines = [
		`[Course update] ${fileName(update.fromPath)} was replaced by a newer version, ${fileName(file.path)}. The [Course method] notes now show the new routes.`,
	];
	if (open.changed.length > 0) {
		lines.push(
			"Changed routes in steps already taught. When the learner next works on one of these, or at the next natural pause, point out briefly what changed (earlier route vs the new one) and check the new route once, then call course_update with the node id:",
		);
		for (const id of open.changed) {
			const previous = update.previous.find((p) => p.nodeId === id);
			const route = previous ? `, earlier route: ${previous.method}${previous.pages ? ` (${previous.pages})` : ""}` : "";
			lines.push(`- ${label(id)}${route}`);
		}
	}
	if (open.planOpen) {
		if (open.changed.length > 0) lines.push("");
		if (open.dropped.length > 0) lines.push(`Steps the new version no longer covers: ${open.dropped.map(label).join(", ")}`);
		if (open.newSections.length > 0) {
			lines.push(`Sections of the new version no plan step covers: ${open.newSections.map((s) => `${s.title} (${s.pages})`).join("; ")}`);
		}
		lines.push(
			'Ask the learner with ask_user_question which of these to add as plan steps and which uncovered steps to drop. Rewrite the plan only for what they accept, then call course_update with "plan".',
		);
	}
	return lines.join("\n");
}

/** The notes due before the next learner input of a teaching turn (plan 007 part 4). */
export function courseNotesFor(
	messages: readonly LhMessage[],
	tree: PlanTree,
	material: CourseMaterial | undefined,
): LhMarkerMessage[] {
	if (!material) return [];
	const binding = new Set(material.files.filter((f) => f.binding && fileCategory(f) === "material").map((f) => f.path));
	const paths = [...binding].sort();
	const referencePaths = material.files.filter((f) => f.binding && fileCategory(f) === "reference").map((f) => f.path).sort();
	if (paths.length === 0 && referencePaths.length === 0) return [];

	const live = messages.slice(projectionHeads(messages).start);
	const notes: LhMarkerMessage[] = [];

	let scope = tree.nodes;
	if (tree.units) {
		const current = derivePlanStatusesLh(tree, messages).current;
		const index = (current ? unitIndexOf(tree, current) : null) ?? 0;
		const ids = new Set(tree.units[index]?.nodeIds ?? []);
		scope = tree.nodes.filter((n) => ids.has(n.id));
	}

	if (paths.length > 0) {
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
		for (const node of scope) {
			const text = methodNoteText(node.id, node.title, material, binding);
			if (text === null) continue;
			const digest = digestOf(text);
			if (!liveDigests.has(`${node.id}\n${digest}`)) notes.push(newCourseMethodNoteMessage(node.id, text, digest));
		}

		// Not limited to the current unit (plan 015 part 3).
		for (const file of material.files) {
			if (!file.update || !binding.has(file.path)) continue;
			const text = courseUpdateNoteText(file, file.update, tree, messages);
			if (text === null) continue;
			const digest = digestOf(text);
			const isLive = live.some(
				(m) =>
					m.role === "custom" && m.customType === "course-update"
					&& (m.details as { digest?: string } | null)?.digest === digest,
			);
			if (!isLive) notes.push(newCourseUpdateNoteMessage(text, digest));
		}
	}

	if (referencePaths.length > 0) {
		const text = referenceNoteText(referencePaths, scope, material);
		const digest = digestOf(text);
		const isLive = live.some(
			(m) =>
				m.role === "custom" && m.customType === "reference"
				&& (m.details as { digest?: string } | null)?.digest === digest,
		);
		if (!isLive) notes.push(newReferenceNoteMessage(text, digest));
	}
	return notes;
}

/** The [Reference] note (plan 012 part 4): the binding reference files and, for the unit's nodes, where in them to look. */
function referenceNoteText(
	referencePaths: readonly string[],
	scope: readonly { id: string; title: string }[],
	material: CourseMaterial,
): string {
	const files = new Set(referencePaths);
	const where: string[] = [];
	for (const node of scope) {
		for (const pointer of material.referencePointers ?? []) {
			if (pointer.nodeId !== node.id || !files.has(pointer.path)) continue;
			const sections = material.referenceIndex?.find((e) => e.path === pointer.path)?.sections ?? [];
			for (const id of pointer.sectionIds) {
				const s = sections.find((x) => x.id === id);
				if (!s) continue;
				const printed = s.label ? `, printed ${s.label}` : "";
				where.push(`- \`${node.id}\` (${node.title}): ${fileName(pointer.path)} §${s.id} ${s.title} (pages ${s.startPage}–${s.endPage}${printed})`);
			}
		}
	}
	return [
		"[Reference] Reference files for this course. They are not course material: they never set what is learned.",
		...referencePaths.map((p) => `- ${p}`),
		...(where.length > 0 ? ["", "Where to look for this unit's nodes:", ...where] : []),
		"",
		"When the learner asks something the course material doesn't answer, or the material leaves a step open, look it up here first: a pdf job with this file, these pages and your question.",
	].join("\n");
}

/** The notes due before the next learner input of a practice turn (plan 007 part 6). */
export function practiceCourseNotesFor(
	messages: readonly LhMessage[],
	material: CourseMaterial | undefined,
): LhMarkerMessage[] {
	if (!material) return [];
	const paths = material.files.filter((f) => f.binding).map((f) => f.path).sort();
	const propositionMethods = material.propositionMethods ?? [];
	if (paths.length === 0 && propositionMethods.length === 0 && (material.propositionExamPatterns ?? []).length === 0) return [];

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

	const propositionExamPatterns = material.propositionExamPatterns ?? [];
	if (propositionExamPatterns.length > 0) {
		const text = [
			"[Exam pattern] The learner's past exams ask about these propositions as follows. Pose problems on them in this shape (task type, givens, answer format, notation, level), with new numbers and functions, and name the model in the statement, e.g. \"in the style of WS22 A3b\". Where grading is given, model solutions and verdicts follow it.",
			...propositionExamPatterns.map(
				(p) =>
					`- [${p.propositionId}] ${p.source} (${p.pages ? `${fileName(p.path)}, ${p.pages}` : fileName(p.path)}): ${p.pattern}${p.grading ? ` Grading: ${p.grading}` : ""}`,
			),
		].join("\n");
		const digest = digestOf(text);
		const isLive = live.some(
			(m) =>
				m.role === "custom" && m.customType === "exam-pattern"
				&& (m.details as { digest?: string } | null)?.digest === digest,
		);
		if (!isLive) notes.push(newExamPatternNoteMessage(text, digest));
	}
	return notes;
}
