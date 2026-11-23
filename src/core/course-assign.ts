import { COURSE_METHOD_CAP, type CourseMaterial, type NodeConflict, type NodeMethod } from "./contracts/course.ts";
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
}

export interface AssignmentNodeOutput {
	nodeId: string;
	pages: string;
	method: string;
	sameRouteAsExisting: boolean | null;
}

export interface AssignmentResult {
	nodes: AssignmentNodeOutput[];
}

export type CourseAssignWorkerResult =
	| { ok: true; result: AssignmentResult }
	| { ok: false; error: string };

export interface CourseAssignWorkerInput {
	chatId: string;
	path: string;
	targets: AssignmentTargetNode[];
	existingMethods: Record<string, ExistingNodeMethod[]>;
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

/** The worker instructions (plan 007 part 3, owner-confirmed), appended after
 *  the pdf-reader's reading doctrine. */
export const COURSE_ASSIGN_INSTRUCTIONS = `You read one course file for a learning application. The learner must pass an exam in this course, so the course's own way of solving each problem is what matters, not the most standard or shortest way.

You get the lesson's plan nodes (id, title, summary). For every node this file actually works through, write down the course's route: the procedure step by step, the notation and conventions it uses, the criteria or tables it applies, in the order the file does it. Write it so a tutor can teach and grade by it without the file. Write the method in the file's language. Cite pages the way the file numbers them, e.g. (S. 12) or (p. 12). Leave out nodes the file only mentions or doesn't cover. Never fill a gap from your own knowledge.

Some nodes already carry a method from another course file. For those, also decide: does this file use the same route (same steps, possibly other wording or notation) or a different route? Set sameRouteAsExisting to true or false.

Return ONE JSON object and nothing else: {"nodes":[{"nodeId":string,"pages":string,"method":string,"sameRouteAsExisting":boolean|null}]}. Each method at most ${COURSE_METHOD_CAP.toLocaleString("en-US")} characters.`;

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
	const entries = (raw as { nodes?: unknown }).nodes;
	if (!Array.isArray(entries)) return { ok: false, problems: ["\"nodes\" must be an array"] };

	const problems: string[] = [];
	const known = new Set(targetIds);
	const seen = new Set<string>();
	const nodes: AssignmentNodeOutput[] = [];
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
		} else if (seen.has(nodeId)) {
			problems.push(`duplicate node id "${nodeId}"`);
			valid = false;
		}
		seen.add(nodeId);
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
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { nodes } };
}

export function applyAssignment(
	material: CourseMaterial,
	filePath: string,
	result: AssignmentResult,
	targetIds?: readonly string[],
): CourseMaterial {
	const targets = new Set(targetIds ?? result.nodes.map((node) => node.nodeId));
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

	const files = material.files.map((file) => {
		if (file.path !== filePath) return file;
		const { error: _error, ...rest } = file;
		return { ...rest, status: "assigned" as const };
	});
	return { ...material, files, methods, conflicts };
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
	const material: CourseMaterial = { ...input.material, methods, conflicts };

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
