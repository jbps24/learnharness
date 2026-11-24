import {
	COURSE_METHOD_CAP,
	EXAM_PATTERN_CAP,
	fileCategory,
	type CourseMaterial,
	type ExamPattern,
	type NodeConflict,
	type NodeMethod,
	type ReferenceSection,
} from "./contracts/course.ts";
import type { PlanTree } from "./contracts/plan.ts";

export interface AssignmentTargetNode {
	id: string;
	title: string;
	summary?: string;
	unitTitle?: string;
	unitSource?: string;
}

export interface ExistingNodeMethod {
	path: string;
	method: string;
}

export interface CourseAssignPromptInput {
	path: string;
	targets: readonly AssignmentTargetNode[];
	existingMethods?: Record<string, readonly ExistingNodeMethod[]>;
	category?: "material" | "exam" | "reference";
}

export interface AssignmentNodeOutput {
	nodeId: string;
	pages: string;
	method: string;
	sameRouteAsExisting: boolean | null;
}

export interface ExamAssignmentNodeOutput {
	nodeId: string;
	source: string;
	pages: string;
	pattern: string;
	grading?: string;
}

export interface ReferencePointerNodeOutput {
	nodeId: string;
	sectionIds: string[];
}

export type AssignmentResult =
	| { category: "material"; nodes: AssignmentNodeOutput[] }
	| { category: "exam"; nodes: ExamAssignmentNodeOutput[] }
	| {
			category: "reference";
			nodes: ReferencePointerNodeOutput[];
			index?: { from: "outline" | "contents" | "headings"; sections: ReferenceSection[] };
	  };

export type CourseAssignWorkerResult =
	| { ok: true; result: AssignmentResult }
	| { ok: false; error: string };

export interface CourseAssignWorkerInput {
	chatId: string;
	path: string;
	targets: AssignmentTargetNode[];
	existingMethods: Record<string, ExistingNodeMethod[]>;
	category?: "material" | "exam" | "reference";
	referenceIndex?: { from: "outline" | "contents" | "headings"; sections: ReferenceSection[] };
	abortSignal: AbortSignal;
}

export type CourseAssignWorker = (input: CourseAssignWorkerInput) => Promise<CourseAssignWorkerResult>;

export type ParseAssignmentResult =
	| { ok: true; value: AssignmentResult }
	| { ok: false; problems: string[] };

export interface AssignmentTarget {
	path: string;
	nodeIds: string[];
}

export type AssignmentTargetsInput =
	| {
			kind: "added";
			material: CourseMaterial;
			added: readonly string[];
			tree: PlanTree | undefined;
	  }
	| {
			kind: "plan_init";
			material: CourseMaterial;
			previousTree: PlanTree | undefined;
			nextTree: PlanTree;
	  };

export interface AssignmentTargetsResult {
	targets: AssignmentTarget[];
	material: CourseMaterial;
}

/** The worker instructions (plan 007 part 3, plan 010 part 2, owner-confirmed),
 *  appended after the pdf-reader's reading doctrine. */
export const COURSE_ASSIGN_INSTRUCTIONS = `You read one course file for a learning application. The learner must pass an exam in this course, so the course's own way of solving each problem is what matters, not the most standard or shortest way.

First decide what this file is. A past exam or exam-like task sheet of the course (tasks with points or a time limit, "Klausur", "Prüfung", "Exam", possibly with a solution) is an **exam**. Anything else (script, lecture notes, exercise solutions that teach a method) is **material**. When the task states the category, use that one.

A published textbook or reference work (ISBN, publisher, edition, numbered chapters) that is not the course's own script, slides or lecture notes is a **reference**. For a reference, return {"category":"reference","nodes":[]} at once; do not read it against the plan.

For **material**, do what follows below and set "category":"material".

You get the lesson's plan nodes (id, title, summary). For every node this file actually works through, write down the course's route: the procedure step by step, the notation and conventions it uses, the criteria or tables it applies, in the order the file does it. Write it so a tutor can teach and grade by it without the file. Write the method in the file's language. Cite pages the way the file numbers them, e.g. (S. 12) or (p. 12). Leave out nodes the file only mentions or doesn't cover. Never fill a gap from your own knowledge.

Some nodes already carry a method from another course file. For those, also decide: does this file use the same route (same steps, possibly other wording or notation) or a different route? Set sameRouteAsExisting to true or false.

For material, return ONE JSON object and nothing else: {"category":"material","nodes":[{"nodeId":string,"pages":string,"method":string,"sameRouteAsExisting":boolean|null}]}. Each method at most ${COURSE_METHOD_CAP.toLocaleString("en-US")} characters.

For an **exam**, set "category":"exam" and, for every plan node one of its tasks exercises, write one entry per task: source (the task as the file names it, with the exam's label if it has one, e.g. "WS22 A3b"), pages, pattern (the task type; what is given; what is asked; the expected answer format such as a sketch, a value, a short justification; typical numbers or functions; the points), and, only when the file contains a solution, grading (which steps earn how many points and the expected final form). Write in the file's language. Never invent a solution the file does not contain. Return ONE JSON object and nothing else: {"category":"exam","nodes":[{"nodeId":string,"source":string,"pages":string,"pattern":string,"grading"?:string}]}. Each pattern and each grading at most ${EXAM_PATTERN_CAP.toLocaleString("en-US")} characters.`;

export function buildAssignmentPrompt(input: CourseAssignPromptInput): string {
	const lines = [`Course file: ${input.path}`, "", "Plan nodes to look for in this file:"];
	for (const node of input.targets) {
		lines.push(`- id: ${node.id}`, `  title: ${node.title}`);
		if (node.summary) lines.push(`  summary: ${node.summary}`);
		if (node.unitTitle) lines.push(`  unit: ${node.unitTitle}`);
		if (node.unitSource) lines.push(`  unit source: ${node.unitSource}`);
		const existing = input.existingMethods?.[node.id] ?? [];
		for (const item of existing) {
			lines.push(`  existing method from ${item.path}: ${item.method}`);
		}
	}
	if (input.category) lines.push("", `This file is a ${input.category}; do not decide again.`);
	lines.push("", "Read the file, then return the JSON object.");
	return lines.join("\n");
}

function stripFence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return fenced ? fenced[1]! : trimmed;
}

export function parseAssignment(text: string, targetIds: readonly string[]): ParseAssignmentResult {
	let raw: unknown;
	try {
		raw = JSON.parse(stripFence(text));
	} catch {
		return { ok: false, problems: ["the output is not valid JSON"] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, problems: ["the output must be one JSON object with a \"nodes\" array"] };
	}
	const category = (raw as { category?: unknown }).category;
	if (category !== "material" && category !== "exam" && category !== "reference") {
		return { ok: false, problems: ["\"category\" must be \"material\", \"exam\" or \"reference\""] };
	}
	// The reader stops at the sort; the pointer mapper fills the nodes in.
	if (category === "reference") return { ok: true, value: { category, nodes: [] } };
	const entries = (raw as { nodes?: unknown }).nodes;
	if (!Array.isArray(entries)) return { ok: false, problems: ["\"nodes\" must be an array"] };

	const problems: string[] = [];
	const known = new Set(targetIds);
	const seen = new Set<string>();
	const nodes: AssignmentNodeOutput[] = [];
	const examNodes: ExamAssignmentNodeOutput[] = [];
	for (const [index, entry] of entries.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			problems.push(`nodes[${index}] is not an object`);
			continue;
		}
		const item = entry as Record<string, unknown>;
		const nodeId = typeof item.nodeId === "string" ? item.nodeId : "";
		const label = nodeId || `nodes[${index}]`;
		let valid = true;
		if (!known.has(nodeId)) {
			problems.push(`unknown node id "${nodeId}"`);
			valid = false;
		} else if (category === "material" && seen.has(nodeId)) {
			problems.push(`duplicate node id "${nodeId}"`);
			valid = false;
		}
		seen.add(nodeId);
		if (category === "exam") {
			const source = typeof item.source === "string" ? item.source : "";
			if (source.trim() === "") {
				problems.push(`${label}: the source is empty`);
				valid = false;
			}
			const pattern = typeof item.pattern === "string" ? item.pattern : "";
			if (pattern.trim() === "") {
				problems.push(`${label}: the pattern is empty`);
				valid = false;
			} else if (pattern.length > EXAM_PATTERN_CAP) {
				problems.push(`${label}: the pattern is ${pattern.length} characters, over the ${EXAM_PATTERN_CAP} cap`);
				valid = false;
			}
			const grading = typeof item.grading === "string" && item.grading.trim() !== "" ? item.grading : undefined;
			if (grading !== undefined && grading.length > EXAM_PATTERN_CAP) {
				problems.push(`${label}: the grading is ${grading.length} characters, over the ${EXAM_PATTERN_CAP} cap`);
				valid = false;
			}
			if (valid) {
				examNodes.push({
					nodeId,
					source,
					pages: typeof item.pages === "string" ? item.pages : "",
					pattern,
					...(grading !== undefined ? { grading } : {}),
				});
			}
			continue;
		}
		const method = typeof item.method === "string" ? item.method : "";
		if (method.trim() === "") {
			problems.push(`${label}: the method is empty`);
			valid = false;
		} else if (method.length > COURSE_METHOD_CAP) {
			problems.push(`${label}: the method is ${method.length} characters, over the ${COURSE_METHOD_CAP} cap`);
			valid = false;
		}
		const same = item.sameRouteAsExisting;
		if (typeof same !== "boolean" && same !== null) {
			problems.push(`${label}: sameRouteAsExisting must be true, false or null`);
			valid = false;
		}
		if (valid) {
			nodes.push({
				nodeId,
				pages: typeof item.pages === "string" ? item.pages : "",
				method,
				sameRouteAsExisting: same as boolean | null,
			});
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: category === "exam" ? { category, nodes: examNodes } : { category, nodes } };
}

export function applyAssignment(
	material: CourseMaterial,
	filePath: string,
	result: AssignmentResult,
	targetIds?: readonly string[],
): CourseMaterial {
	const current = material.files.find((file) => file.path === filePath);
	const locked = current?.categoryBy === "learner" && current.category !== undefined;
	// A learner-set category wins; an answer of the other category is ignored.
	const category = locked ? current.category! : result.category;
	const categoryBy = locked ? ("learner" as const) : ("reader" as const);
	const flipped = current !== undefined && fileCategory(current) !== category;
	const finish = (rest: Partial<CourseMaterial>): CourseMaterial => {
		const files = material.files.map((file) => {
			if (file.path !== filePath) return file;
			const { error: _error, ...kept } = file;
			return { ...kept, status: "assigned" as const, category, categoryBy };
		});
		return { ...material, ...rest, files };
	};
	if (result.category !== category) return finish({});

	const targets = new Set(targetIds ?? result.nodes.map((node) => node.nodeId));
	if (result.category === "reference") {
		const referencePointers = [
			...(material.referencePointers ?? []).filter((p) => p.path !== filePath || !targets.has(p.nodeId)),
			...result.nodes.map((node) => ({ nodeId: node.nodeId, path: filePath, sectionIds: node.sectionIds })),
		];
		const referenceIndex = result.index
			? [
					...(material.referenceIndex ?? []).filter((entry) => entry.path !== filePath),
					{ path: filePath, from: result.index.from, sections: result.index.sections },
				]
			: material.referenceIndex;
		const methods = material.methods.filter((m) => m.path !== filePath);
		const conflicts = material.conflicts
			.map(({ chosen, ...rest }) => ({
				...rest,
				paths: rest.paths.filter((p) => p !== filePath),
				...(chosen && chosen !== filePath ? { chosen } : {}),
			}))
			.filter((c) => c.paths.length >= 2);
		const examPatterns = (material.examPatterns ?? []).filter((p) => p.path !== filePath);
		return finish({
			methods,
			conflicts,
			referencePointers,
			...(referenceIndex ? { referenceIndex } : {}),
			...(material.examPatterns ? { examPatterns } : {}),
		});
	}
	const referenceCleanup: Partial<CourseMaterial> = {
		...(material.referenceIndex ? { referenceIndex: material.referenceIndex.filter((entry) => entry.path !== filePath) } : {}),
		...(material.referencePointers ? { referencePointers: material.referencePointers.filter((pointer) => pointer.path !== filePath) } : {}),
	};
	if (result.category === "exam") {
		const examPatterns: ExamPattern[] = [
			...(material.examPatterns ?? []).filter((p) => p.path !== filePath || !targets.has(p.nodeId)),
			...result.nodes.map((node) => ({
				nodeId: node.nodeId,
				path: filePath,
				source: node.source,
				...(node.pages ? { pages: node.pages } : {}),
				pattern: node.pattern,
				...(node.grading ? { grading: node.grading } : {}),
			})),
		];
		const methods = flipped ? material.methods.filter((m) => m.path !== filePath) : material.methods;
		const conflicts = flipped
			? material.conflicts
					.map(({ chosen, ...rest }) => ({
						...rest,
						paths: rest.paths.filter((p) => p !== filePath),
						...(chosen && chosen !== filePath ? { chosen } : {}),
					}))
					.filter((c) => c.paths.length >= 2)
			: material.conflicts;
		return finish({ examPatterns, methods, conflicts, ...referenceCleanup });
	}
	const examPatterns = (material.examPatterns ?? []).filter((p) => p.path !== filePath || (!flipped && !targets.has(p.nodeId)));
	const methods: NodeMethod[] = material.methods.filter((m) => !(m.path === filePath && targets.has(m.nodeId)));
	let conflicts: NodeConflict[] = material.conflicts.map((c) => ({ ...c, paths: [...c.paths] }));

	for (const node of result.nodes) {
		if (node.sameRouteAsExisting === false) {
			const conflict = conflicts.find((c) => c.nodeId === node.nodeId);
			if (conflict) {
				if (!conflict.paths.includes(filePath)) conflict.paths.push(filePath);
			} else {
				const others = [...new Set(methods.filter((m) => m.nodeId === node.nodeId && m.path !== filePath).map((m) => m.path))];
				if (others.length > 0) conflicts = [...conflicts, { nodeId: node.nodeId, paths: [...others, filePath] }];
			}
		}
		methods.push({
			nodeId: node.nodeId,
			path: filePath,
			...(node.pages ? { pages: node.pages } : {}),
			method: node.method,
		});
	}

	return finish({ methods, conflicts, ...(material.examPatterns ? { examPatterns } : {}), ...referenceCleanup });
}

export function assignmentTargets(input: AssignmentTargetsInput): AssignmentTargetsResult {
	if (input.kind === "added") {
		const tree = input.tree;
		if (!tree || tree.nodes.length === 0) return { targets: [], material: input.material };
		const added = new Set(input.added);
		const targets = input.material.files
			.filter((file) => added.has(file.path) && file.binding && file.status !== "not-assignable")
			.map((file) => ({ path: file.path, nodeIds: tree.nodes.map((node) => node.id) }));
		return { targets, material: input.material };
	}

	const { previousTree, nextTree } = input;
	const live = new Set(nextTree.nodes.map((node) => node.id));
	const methods = input.material.methods.filter((m) => live.has(m.nodeId));
	const conflicts = input.material.conflicts.filter((c) => live.has(c.nodeId) && c.paths.length >= 2);
	const material: CourseMaterial = {
		...input.material,
		methods,
		conflicts,
		...(input.material.referencePointers
			? { referencePointers: input.material.referencePointers.filter((p) => live.has(p.nodeId)) }
			: {}),
	};

	const previous = new Map((previousTree?.nodes ?? []).map((node) => [node.id, node]));
	const changed = nextTree.nodes
		.filter((node) => {
			const before = previous.get(node.id);
			return !before || before.title !== node.title || before.summary !== node.summary;
		})
		.map((node) => node.id);
	const all = nextTree.nodes.map((node) => node.id);

	const targets: AssignmentTarget[] = [];
	for (const file of input.material.files) {
		if (!file.binding) continue;
		if ((file.status === "assigned" || file.status === "assigning") && changed.length > 0) targets.push({ path: file.path, nodeIds: changed });
		else if (file.status === "pending" && previousTree === undefined && all.length > 0) targets.push({ path: file.path, nodeIds: all });
	}
	return { targets, material };
}
