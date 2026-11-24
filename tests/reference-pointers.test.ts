import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReferenceSection } from "../src/core/contracts/course.ts";
import {
	buildReferenceMapperPrompt,
	parseReferencePointers,
	REFERENCE_MAPPER_INSTRUCTIONS,
	REFERENCE_POINTER_CAP,
} from "../src/core/reference-pointers.ts";

describe("REFERENCE_MAPPER_INSTRUCTIONS", () => {
	// plan 012 part 3: confirmed mapper instructions verbatim
	it("matches the owner-confirmed mapper instructions verbatim", () => {
		assert.equal(
			REFERENCE_MAPPER_INSTRUCTIONS,
			'You map a lesson\'s plan nodes to the sections of a reference book, using only its table of contents. For each node, list up to 3 of the most specific sections whose content covers it, most relevant first. Leave out nodes no section covers. Return ONE JSON object and nothing else: {"nodes":[{"nodeId":string,"sections":[sectionId]}]}.',
		);
	});
});

describe("buildReferenceMapperPrompt", () => {
	// plan 012 part 3: pointer mapper prompt includes TOC lines (id title (pp.)) and target nodes (id, title, summary, unit)
	it("includes TOC lines and target node details", () => {
		const sections: ReferenceSection[] = [
			{ id: "s1", title: "Chapter 1: Laplace Transform", level: 1, startPage: 10, endPage: 35 },
			{ id: "s2", title: "1.1 Region of Convergence", level: 2, startPage: 12, endPage: 18 },
		];
		const prompt = buildReferenceMapperPrompt({
			path: "/course/oppenheim.pdf",
			sections,
			targets: [
				{
					id: "n1",
					title: "Laplace poles",
					summary: "Locate poles and zeros in the s-plane",
					unitTitle: "Complex frequency",
					unitSource: "Lecture 2",
				},
			],
		});
		assert.ok(prompt.includes("s1"));
		assert.ok(prompt.includes("Chapter 1: Laplace Transform"));
		assert.ok(prompt.includes("10"));
		assert.ok(prompt.includes("35"));
		assert.ok(prompt.includes("s2"));
		assert.ok(prompt.includes("1.1 Region of Convergence"));
		assert.ok(prompt.includes("n1"));
		assert.ok(prompt.includes("Laplace poles"));
		assert.ok(prompt.includes("Locate poles and zeros in the s-plane"));
		assert.ok(prompt.includes("Complex frequency"));
		assert.ok(prompt.includes("Lecture 2"));
	});

	// plan 012 part 3: optional unitTitle and unitSource are included independently when set
	it("renders unitTitle and unitSource independently without emitting undefined", () => {
		const sections: ReferenceSection[] = [
			{ id: "s1", title: "Chapter 1", level: 1, startPage: 1, endPage: 10 },
		];
		const titleOnly = buildReferenceMapperPrompt({
			path: "/course/book.pdf",
			sections,
			targets: [{ id: "n1", title: "Poles", unitTitle: "Complex frequency" }],
		});
		assert.ok(titleOnly.includes("  unit: Complex frequency"));
		assert.ok(!titleOnly.includes("unit source:"));

		const sourceOnly = buildReferenceMapperPrompt({
			path: "/course/book.pdf",
			sections,
			targets: [{ id: "n2", title: "Zeros", unitSource: "Lecture 2" }],
		});
		assert.ok(sourceOnly.includes("  unit source: Lecture 2"));
		assert.ok(!sourceOnly.includes("  unit:"));
	});
});

describe("parseReferencePointers", () => {
	const TARGETS = ["n1", "n2", "n3"];
	const SECTIONS = ["s1", "s2", "s3", "s4"];

	// plan 012 part 3: valid mapping with up to 3 sections per node preserves order (most relevant first)
	it("parses valid mappings with up to 3 sections per node in order", () => {
		const raw = JSON.stringify({
			nodes: [
				{ nodeId: "n1", sections: ["s3", "s1"] },
				{ nodeId: "n2", sections: ["s1", "s2", "s4"] },
			],
		});
		const parsed = parseReferencePointers(raw, TARGETS, SECTIONS);
		assert.deepEqual(parsed, {
			ok: true,
			nodes: [
				{ nodeId: "n1", sectionIds: ["s3", "s1"] },
				{ nodeId: "n2", sectionIds: ["s1", "s2", "s4"] },
			],
		});
	});

	// plan 012 part 3: leave out nodes no section covers -> empty nodes array is valid
	it("accepts an empty nodes array", () => {
		const parsed = parseReferencePointers(JSON.stringify({ nodes: [] }), TARGETS, SECTIONS);
		assert.deepEqual(parsed, { ok: true, nodes: [] });
	});

	// plan 012 part 3: non-JSON, non-object, or missing/non-array nodes is rejected
	it("rejects non-JSON, non-object, and non-array nodes", () => {
		for (const bad of ["not json", "[]", "{}"]) {
			const parsed = parseReferencePointers(bad, TARGETS, SECTIONS);
			assert.equal(parsed.ok, false);
			assert.ok(parsed.problems.length > 0);
		}
	});

	// plan 012 part 3: unknown node id is rejected
	it("rejects an unknown nodeId", () => {
		const parsed = parseReferencePointers(
			JSON.stringify({ nodes: [{ nodeId: "unknown-node", sections: ["s1"] }] }),
			TARGETS,
			SECTIONS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("unknown-node")));
	});

	// plan 012 part 3: duplicate node id is rejected
	it("rejects duplicate nodeIds", () => {
		const parsed = parseReferencePointers(
			JSON.stringify({
				nodes: [
					{ nodeId: "n1", sections: ["s1"] },
					{ nodeId: "n1", sections: ["s2"] },
				],
			}),
			TARGETS,
			SECTIONS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("n1")));
	});

	// plan 012 part 3: unknown section id is rejected
	it("rejects an unknown sectionId", () => {
		const parsed = parseReferencePointers(
			JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s999"] }] }),
			TARGETS,
			SECTIONS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("s999")));
	});

	// plan 012 part 3: <= 3 sections per node
	it("rejects more than 3 sections per node", () => {
		assert.equal(REFERENCE_POINTER_CAP, 3);
		const parsed = parseReferencePointers(
			JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s1", "s2", "s3", "s4"] }] }),
			TARGETS,
			SECTIONS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.some((p) => p.includes("n1")));
	});

	// plan 012 part 3: sections must be an array
	it("rejects non-array sections", () => {
		const parsed = parseReferencePointers(
			JSON.stringify({ nodes: [{ nodeId: "n1", sections: "s1" }] }),
			TARGETS,
			SECTIONS,
		);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.problems.length > 0);
	});

	// plan 012 part 3: fenced JSON output is unwrapped before parsing
	it("parses JSON wrapped in markdown code fences", () => {
		const json = JSON.stringify({ nodes: [{ nodeId: "n1", sections: ["s2"] }] });
		for (const fenced of [`\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\``]) {
			const parsed = parseReferencePointers(fenced, TARGETS, SECTIONS);
			assert.deepEqual(parsed, { ok: true, nodes: [{ nodeId: "n1", sectionIds: ["s2"] }] });
		}
	});
});
