import type { ReferenceSection } from "./contracts/course.ts";
import type { AssignmentTargetNode } from "./course-assign.ts";

export const REFERENCE_POINTER_CAP = 3;

/** Owner-confirmed (plan 012 part 3): the pointer mapper's system instructions. */
export const REFERENCE_MAPPER_INSTRUCTIONS =
	'You map a lesson\'s plan nodes to the sections of a reference book, using only its table of contents. For each node, list up to 3 of the most specific sections whose content covers it, most relevant first. Leave out nodes no section covers. Return ONE JSON object and nothing else: {"nodes":[{"nodeId":string,"sections":[sectionId]}]}.';

export interface ReferencePointerOutput {
	nodeId: string;
	sectionIds: string[];
}

export interface ReferenceMapperPromptInput {
	path: string;
	sections: readonly ReferenceSection[];
	targets: readonly AssignmentTargetNode[];
}

export type ParseReferencePointersResult =
	| { ok: true; nodes: ReferencePointerOutput[] }
	| { ok: false; problems: string[] };

export function buildReferenceMapperPrompt(input: ReferenceMapperPromptInput): string {
	const lines = [`Reference file: ${input.path}`, "", "Table of contents (id title (pp.)):"];
	for (const section of input.sections) {
		lines.push(`${section.id} ${section.title} (pp. ${section.startPage}–${section.endPage})`);
	}
	lines.push("", "Plan nodes to map:");
	for (const node of input.targets) {
		lines.push(`- id: ${node.id}`, `  title: ${node.title}`);
		if (node.summary) lines.push(`  summary: ${node.summary}`);
		if (node.unitTitle) lines.push(`  unit: ${node.unitTitle}`);
		if (node.unitSource) lines.push(`  unit source: ${node.unitSource}`);
	}
	lines.push("", "Return the JSON object.");
	return lines.join("\n");
}

function stripFence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return fenced ? fenced[1]! : trimmed;
}

export function parseReferencePointers(
	raw: string,
	targetIds: readonly string[],
	sectionIds: readonly string[],
): ParseReferencePointersResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch {
		return { ok: false, problems: ["the output is not valid JSON"] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, problems: ["the output must be one JSON object with a \"nodes\" array"] };
	}
	const entries = (parsed as { nodes?: unknown }).nodes;
	if (!Array.isArray(entries)) return { ok: false, problems: ["\"nodes\" must be an array"] };

	const problems: string[] = [];
	const knownNodes = new Set(targetIds);
	const knownSections = new Set(sectionIds);
	const seen = new Set<string>();
	const nodes: ReferencePointerOutput[] = [];
	for (const [index, entry] of entries.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			problems.push(`nodes[${index}] is not an object`);
			continue;
		}
		const item = entry as Record<string, unknown>;
		const nodeId = typeof item.nodeId === "string" ? item.nodeId : "";
		const label = nodeId || `nodes[${index}]`;
		let valid = true;
		if (!knownNodes.has(nodeId)) {
			problems.push(`unknown node id "${nodeId}"`);
			valid = false;
		} else if (seen.has(nodeId)) {
			problems.push(`duplicate node id "${nodeId}"`);
			valid = false;
		}
		seen.add(nodeId);
		const sections = item.sections;
		if (!Array.isArray(sections)) {
			problems.push(`${label}: "sections" must be an array`);
			continue;
		}
		if (sections.length > REFERENCE_POINTER_CAP) {
			problems.push(`${label}: ${sections.length} sections, over the cap of ${REFERENCE_POINTER_CAP}`);
			valid = false;
		}
		for (const id of sections) {
			if (typeof id !== "string" || !knownSections.has(id)) {
				problems.push(`${label}: unknown section id "${String(id)}"`);
				valid = false;
			}
		}
		if (valid && sections.length > 0) nodes.push({ nodeId, sectionIds: sections as string[] });
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, nodes };
}
