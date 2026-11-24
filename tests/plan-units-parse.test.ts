import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMermaidPlan } from "../src/agent/tools/mermaid-plan.ts";

describe("parseMermaidPlan — units", () => {
	// plan 001 part 1: `units` is absent (not `[]`) when the block has no subgraph.
	it("leaves units absent when the block has no subgraph", () => {
		const res = parseMermaidPlan("graph TD\n a --> b");
		assert.equal(res.ok, true);
		assert.ok(res.plan);
		assert.equal(res.plan.units, undefined);
		assert.equal("units" in res.plan, false);
	});

	// plan 001 part 1: example with two units, source on first, top-level cross-unit edge.
	it("parses flat subgraphs into ordered units with source and nodeIds", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph basics[Grundlagen]",
			"    %% source: Skript Kap. 1, S. 3–20",
			"    ode1[ODEs erster Ordnung] --> expeig[Eigenwerte]",
			"  end",
			"  subgraph stab[Stabilität]",
			"    poles[Pole] --> loop[Regelkreis]",
			"  end",
			"  expeig --> poles",
		].join("\n"));
		assert.equal(res.ok, true);
		assert.deepEqual(res.plan?.units, [
			{
				id: "basics",
				title: "Grundlagen",
				source: "Skript Kap. 1, S. 3–20",
				nodeIds: ["ode1", "expeig"],
			},
			{
				id: "stab",
				title: "Stabilität",
				nodeIds: ["poles", "loop"],
			},
		]);
		assert.equal("source" in res.plan!.units![1]!, false);
	});

	// plan 001 part 1, rules 1 & 2: subgraph forms, quote stripping, case-insensitive keywords.
	it("accepts square, quoted-square, and paren titles and case-insensitive subgraph/end", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  SUBGRAPH u1[Plain Title]",
			"    a[A]",
			"  END",
			'  subgraph u2["Quoted Square"]',
			"    b[B]",
			"  End",
			'  subgraph u3("Quoted Paren")',
			"    c[C]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, true);
		assert.deepEqual(res.plan?.units, [
			{ id: "u1", title: "Plain Title", nodeIds: ["a"] },
			{ id: "u2", title: "Quoted Square", nodeIds: ["b"] },
			{ id: "u3", title: "Quoted Paren", nodeIds: ["c"] },
		]);
	});

	// plan 001 part 1, rule 3: nested subgraph.
	it("rejects nested subgraph", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph outer[Outer]",
			"    subgraph inner[Inner]",
			"      a[A]",
			"    end",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 3: units can't be nested — close `outer` with `end` first."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: stray `end` with no open unit.
	it("rejects stray end with no open unit", () => {
		const res = parseMermaidPlan(["graph TD", "  a[A]", "  end"].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 3: `end` closes nothing — no unit is open."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: unclosed unit at end of block (N = the subgraph line).
	it("rejects unclosed unit citing the subgraph line", () => {
		const res = parseMermaidPlan(["graph TD", "  subgraph basics[Basics]", "    a[A]"].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 2: unit `basics` is never closed — add `end`."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: unit id breaking the slug rule.
	it("rejects unit id that breaks the slug rule", () => {
		const res = parseMermaidPlan(["graph TD", "  subgraph Basics[Basics]", "    a[A]", "  end"].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes(
				"line 2: unit id `Basics` must be a lowercase slug (a-z, 0-9, joined by hyphens or underscores — e.g. `chain-rule-intuition`); ids are permanent and checks reference them.",
			),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: unit without a title.
	it("rejects unit without a title", () => {
		const res = parseMermaidPlan(["graph TD", "  subgraph basics", "    a[A]", "  end"].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 2: unit `basics` needs a title — `subgraph basics[Short Title]`."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: duplicate unit id.
	it("rejects duplicate unit id", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph u1[First]",
			"    a[A]",
			"  end",
			"  subgraph u1[Second]",
			"    b[B]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 5: unit id `u1` is used twice."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: unit id equal to a node id.
	it("rejects unit id equal to a node id", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph alpha[Alpha Unit]",
			"    alpha[Alpha Node]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.some((p) => p.includes("unit id `alpha` is also a node id — ids must be distinct.")),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 3: unit with no nodes.
	it("rejects empty unit with no nodes", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph empty_u[Empty]",
			"    %% just a comment",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 2: unit `empty_u` has no nodes."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 4: %% source: trimmed, empty counts as absent, other %% comments ignored.
	it("trims %% source:, treats empty %% source: as absent, and ignores other %% comments", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  %% top-level comment",
			"  subgraph u1[U1]",
			"    %% source:   Chapter 2   ",
			"    %% another comment",
			"    a[A]",
			"  end",
			"  subgraph u2[U2]",
			"    %% source:   ",
			"    b[B]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, true);
		assert.equal(res.plan?.units?.[0]?.source, "Chapter 2");
		assert.equal(res.plan?.units?.[1]?.source, undefined);
		assert.equal("source" in res.plan!.units![1]!, false);
	});

	// plan 001 part 1, rule 4: second %% source: in the same unit.
	it("rejects a second %% source: in the same unit", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph u1[U1]",
			"    %% source: Ch 1",
			"    %% source: Ch 2",
			"    a[A]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 4: unit `u1` already has a source."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 4: %% source: outside any unit.
	it("rejects %% source: outside any unit", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  %% source: Ch 1",
			"  subgraph u1[U1]",
			"    a[A]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 2: `%% source:` belongs inside a unit (between `subgraph` and `end`)."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rules 5 & 6: first appearance wins; bare references and edge endpoints in later units do not error.
	it("keeps node in first-appearance unit when referenced as edge endpoint or bare node in a later unit", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph u1[First]",
			"    a[Alpha]",
			"  end",
			"  subgraph u2[Second]",
			"    a --> b[Beta]",
			"    a",
			"  end",
		].join("\n"));
		assert.equal(res.ok, true);
		assert.deepEqual(res.plan?.units, [
			{ id: "u1", title: "First", nodeIds: ["a"] },
			{ id: "u2", title: "Second", nodeIds: ["b"] },
		]);
	});

	// plan 001 part 1, rule 6: labelled node line for an id already in another unit.
	it("rejects labelled node line for an id already in a different unit", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph u1[First]",
			"    a[Alpha]",
			"  end",
			"  subgraph u2[Second]",
			"    a[Alpha Again]",
			"    b[Beta]",
			"  end",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.includes("line 6: node `a` is already in unit `u1` — a node belongs to exactly one unit."),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 7: nodes outside any unit when at least one unit exists.
	it("rejects nodes first appearing outside any unit when units exist", () => {
		const res = parseMermaidPlan("graph TD\n a --> b\n subgraph u1[U]\n c\n end");
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.some((p) =>
				p.includes("nodes outside any unit: a, b — when the plan has units, every node must be inside one."),
			),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 8: order check — prerequisite in a later unit.
	it("rejects edge whose prerequisite sits in a later unit", () => {
		const res = parseMermaidPlan([
			"graph TD",
			"  subgraph basics[Grundlagen]",
			"    ode1[ODEs erster Ordnung] --> expeig[Eigenwerte]",
			"  end",
			"  subgraph stab[Stabilität]",
			"    poles[Pole] --> loop[Regelkreis]",
			"  end",
			"  expeig --> poles",
			"  poles --> expeig",
		].join("\n"));
		assert.equal(res.ok, false);
		assert.ok(
			res.problems.some((p) =>
				p.includes(
					"edge `poles` --> `expeig`: the prerequisite is in a later unit (`stab` comes after `basics`) — move it to the same or an earlier unit.",
				),
			),
			`unexpected problems: ${res.problems.join(" | ")}`,
		);
	});

	// plan 001 part 1, rule 9: remove "subgraphs" from unsupported constructs in parse-failure message.
	it("omits subgraphs from the parse-failure unsupported constructs message", () => {
		const res = parseMermaidPlan("graph TD\n  style a fill:#f9f");
		assert.equal(res.ok, false);
		assert.equal(res.problems.length, 1);
		assert.equal(res.problems[0]!.includes("subgraphs"), false);
		assert.equal(res.problems[0]!.includes("styles"), true);
		assert.equal(res.problems[0]!.includes("classes"), true);
	});
});
