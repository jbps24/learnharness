/**
 * Mermaid → PlanTree authoring format (the author-once protocol, 2026-09-03;
 * free-form pass 2026-09-11 — the muscle-protein session post-mortem: four
 * failed plan_init calls over ids the parser silently hated).
 *
 * The teacher writes the session map as a mermaid block — the format models
 * are most fluent in — and plan_init canonicalizes it into the structured
 * PlanTree. Hand-parsed subset: deterministic, dependency-free, precise
 * line-numbered errors the teacher can act on (the same validate-and-retry
 * loop as the question schemas). Not the mermaid runtime — the server never
 * renders, it only needs the graph.
 *
 * THE ONE STRICT RULE: node ids are permanent slugs the teacher references
 * via quiz nodeId — lowercase words (a-z, 0-9) joined by hyphens OR
 * underscores (`chain-rule-intuition`, `mps_translation`). Everything else
 * is as free-form as mermaid allows:
 *   graph|flowchart TD|TB|LR|RL|BT   (direction is cosmetic — we layout
 *                                     ourselves; case-insensitive)
 *   %% comment lines
 *   subgraph id[Title] … end   — a flat unit (ordered by its subgraph line);
 *                     `%% source: <text>` inside sets the unit's source. A node
 *                     belongs to the unit open where its id FIRST appears.
 *   node            — bare id (title falls back to the id)
 *   id[title]       — square-bracket label; any single-line title, a
 *                     surrounding "…" pair is stripped
 *   id("title")     — paren label
 *   a --> b         — requires edge (from = prerequisite); ==>, -.-> are
 *                     synonyms; chains a --> b --> c expand to pairs
 *   a[title] --> b[title] — inline labels anywhere an endpoint appears
 * Bare endpoints register as nodes; forward references are fine; duplicate
 * edges dedupe; the first label a node gets wins.
 */
import type { PlanEdge, PlanNode, PlanUnit } from "@/src/core";

export interface ParsedPlan {
	nodes: PlanNode[];
	edges: PlanEdge[];
	units?: PlanUnit[];
}

export interface PlanParseResult {
	ok: boolean;
	/** All problems, each prefixed with its 1-based line number. */
	problems: string[];
	plan?: ParsedPlan;
}

const HEADER_RE = /^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*$/i;
const SLUG_RE = /^[a-z0-9]+([_-][a-z0-9]+)*$/;
/** Any arrow spelling counts as a requires-edge; chains split on it. */
const SUBGRAPH_RE = /^subgraph\s+(.+)$/i;
const END_RE = /^end$/i;
const SOURCE_RE = /^%%\s*source:(.*)$/;
const ARROW_RE = /-->|==>|-\.->/;
/** One edge endpoint: `id`, `id[title]`, or `id("title")`. */
// The id CANDIDATE class is deliberately broad — anything but whitespace,
// brackets, parens — so EVERY bad id (UPPER, dots, underscores…) reaches
// register()'s SPECIFIC slug message instead of dying at the regex layer
// with a generic parse error. The muscle-protein post-mortem: underscores
// failed HERE, the actionable message never fired, and the teacher spent
// four attempts hunting punctuation the parser didn't care about.
const ENDPOINT_RE = /^([^\s()\[\]]+)\s*(?:\[([^\[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/;

interface Endpoint {
	id: string;
	label?: string;
}

function parseEndpoint(text: string): Endpoint | null {
	const m = text.trim().match(ENDPOINT_RE);
	if (!m || !m[1]) return null;
	let label = (m[2] ?? m[3] ?? m[4] ?? "").trim();
	// `id["title"]` is idiomatic mermaid — don't keep the quote pair in the title.
	if (
		label.length >= 2 &&
		((label.startsWith('"') && label.endsWith('"')) || (label.startsWith("'") && label.endsWith("'")))
	) {
		label = label.slice(1, -1).trim();
	}
	return { id: m[1], label };
}

/** Parse the mermaid subset. Collects ALL problems (never just the first). */
export function parseMermaidPlan(mermaid: string): PlanParseResult {
	const problems: string[] = [];
	const lines = mermaid.split(/\r?\n/);

	// Header: required, first non-empty non-comment line.
	const first = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("%%"));
	if (first === -1) {
		return { ok: false, problems: ["The plan is empty — expected a `graph TD` block with nodes and `-->` requires-edges."] };
	}
	const header = lines[first]?.trim() ?? "";
	if (!HEADER_RE.test(header)) {
		problems.push(`line ${first + 1}: expected the header \`graph TD\` (or flowchart TD/TB) first, got \`${header}\`.`);
	}

	const nodes = new Map<string, string>(); // id → title (first label wins)
	const edges: PlanEdge[] = [];
	const seenEdges = new Set<string>();

	interface OpenUnit {
		id: string;
		title: string;
		source?: string;
		nodeIds: string[];
		line: number;
	}
	const units: OpenUnit[] = [];
	let open: OpenUnit | null = null;
	const nodeUnit = new Map<string, OpenUnit>(); // id → unit it first appeared in
	const slugProblem = (kind: string, id: string, lineNo: number): string =>
		`line ${lineNo}: ${kind} id \`${id}\` must be a lowercase slug (a-z, 0-9, joined by hyphens or underscores — e.g. \`chain-rule-intuition\`); ids are permanent and checks reference them.`;
	const closeUnit = (u: OpenUnit): void => {
		if (u.nodeIds.length === 0) problems.push(`line ${u.line}: unit \`${u.id}\` has no nodes.`);
	};

	const register = ({ id, label }: Endpoint, lineNo: number): void => {
		if (!SLUG_RE.test(id)) {
			problems.push(slugProblem("node", id, lineNo));
			return;
		}
		if (!nodes.has(id) && open) {
			nodeUnit.set(id, open);
			open.nodeIds.push(id);
		}
		if (!nodes.has(id)) nodes.set(id, label && label.length > 0 ? label : id);
		else if (label && label.length > 0 && nodes.get(id) === id) nodes.set(id, label);
	};

	for (let i = first + 1; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		const no = i + 1;
		const src = line.match(SOURCE_RE);
		if (src) {
			if (!open) {
				problems.push(`line ${no}: \`%% source:\` belongs inside a unit (between \`subgraph\` and \`end\`).`);
			} else if (open.source !== undefined) {
				problems.push(`line ${no}: unit \`${open.id}\` already has a source.`);
			} else {
				const text = (src[1] ?? "").trim();
				if (text.length > 0) open.source = text;
			}
			continue;
		}
		if (line.length === 0 || line.startsWith("%%")) continue;

		const sub = line.match(SUBGRAPH_RE);
		if (sub) {
			if (open) {
				problems.push(`line ${no}: units can't be nested — close \`${open.id}\` with \`end\` first.`);
				continue;
			}
			const ep = parseEndpoint(sub[1] ?? "");
			if (!ep) {
				problems.push(`line ${no}: can't read the unit \`${line}\` — expected \`subgraph <id>[Short Title]\`.`);
				open = { id: (sub[1] ?? "").trim(), title: "", nodeIds: [], line: no };
				units.push(open);
				continue;
			}
			if (!SLUG_RE.test(ep.id)) problems.push(slugProblem("unit", ep.id, no));
			else if (units.some((u) => u.id === ep.id)) problems.push(`line ${no}: unit id \`${ep.id}\` is used twice.`);
			if (!ep.label) problems.push(`line ${no}: unit \`${ep.id}\` needs a title — \`subgraph ${ep.id}[Short Title]\`.`);
			open = { id: ep.id, title: ep.label ?? "", nodeIds: [], line: no };
			units.push(open);
			continue;
		}
		if (END_RE.test(line)) {
			if (!open) problems.push(`line ${no}: \`end\` closes nothing — no unit is open.`);
			else {
				closeUnit(open);
				open = null;
			}
			continue;
		}

		// Edges (incl. chains): split on any arrow spelling; every segment is
		// an endpoint, consecutive pairs become requires-edges.
		const segments = line.split(ARROW_RE);
		if (segments.length >= 2) {
			const endpoints: Endpoint[] = [];
			let unreadable = false;
			for (const seg of segments) {
				const ep = parseEndpoint(seg);
				if (!ep) {
					problems.push(
						`line ${no}: can't read the edge \`${line}\` — expected \`a[title] --> b[title]\` (chains like \`a --> b --> c\` are fine).`,
					);
					unreadable = true;
					break;
				}
				endpoints.push(ep);
			}
			if (!unreadable) {
				for (const ep of endpoints) register(ep, no);
				for (let k = 0; k + 1 < endpoints.length; k++) {
					const from = endpoints[k]!;
					const to = endpoints[k + 1]!;
					if (from.id === to.id) {
						problems.push(`line ${no}: self-loop \`${from.id} --> ${to.id}\` — a node can't require itself.`);
						continue;
					}
					const key = `${from.id}->${to.id}`;
					if (!seenEdges.has(key)) {
						seenEdges.add(key);
						edges.push({ from: from.id, to: to.id });
					}
				}
			}
		} else {
			const node = parseEndpoint(line);
			const owner = node ? nodeUnit.get(node.id) : undefined;
			if (node?.label && owner && open && owner !== open) {
				problems.push(
					`line ${no}: node \`${node.id}\` is already in unit \`${owner.id}\` — a node belongs to exactly one unit.`,
				);
				continue;
			}
			if (!node) {
				problems.push(
					`line ${no}: can't parse \`${line}\` — ids are the strict part (lowercase slugs: a-z, 0-9, hyphens, underscores); node lines (\`slug[title]\`) and requires-edges (\`a --> b\`) are the accepted forms; styles and classes are not part of the subset.`,
				);
				continue;
			}
			register(node, no);
		}
	}

	if (open) {
		const u: OpenUnit = open;
		problems.push(`line ${u.line}: unit \`${u.id}\` is never closed — add \`end\`.`);
		closeUnit(u);
	}
	if (units.length > 0) {
		for (const u of units) {
			if (nodes.has(u.id)) {
				problems.push(`line ${u.line}: unit id \`${u.id}\` is also a node id — ids must be distinct.`);
			}
		}
		const outside = [...nodes.keys()].filter((id) => !nodeUnit.has(id));
		if (outside.length > 0) {
			problems.push(`nodes outside any unit: ${outside.join(", ")} — when the plan has units, every node must be inside one.`);
		}
		for (const e of edges) {
			const uf = nodeUnit.get(e.from);
			const ut = nodeUnit.get(e.to);
			if (uf && ut && units.indexOf(uf) > units.indexOf(ut)) {
				problems.push(
					`edge \`${e.from}\` --> \`${e.to}\`: the prerequisite is in a later unit (\`${uf.id}\` comes after \`${ut.id}\`) — move it to the same or an earlier unit.`,
				);
			}
		}
	}
	const plan: ParsedPlan = {
		nodes: [...nodes.entries()].map(([id, title]) => ({ id, title })),
		edges,
	};
	if (units.length > 0) {
		plan.units = units.map((u) => ({
			id: u.id,
			title: u.title,
			...(u.source !== undefined ? { source: u.source } : {}),
			nodeIds: [...u.nodeIds],
		}));
	}
	if (problems.length > 0) return { ok: false, problems };
	if (plan.nodes.length === 0) return { ok: false, problems: ["No nodes found — the plan needs at least one."] };
	return { ok: true, problems: [], plan };
}
