import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanEdge, PlanNode, PlanUnit } from "../src/core/contracts.ts";
import { createTree, PlanTreeError } from "../src/core/plan-tree.ts";

const N = (id: string, title = id): PlanNode => ({ id, title });
const E = (from: string, to: string): PlanEdge => ({ from, to });
const U = (id: string, title: string, nodeIds: string[], source?: string): PlanUnit => ({
	id,
	title,
	...(source !== undefined ? { source } : {}),
	nodeIds,
});

function assertReject(fn: () => unknown): void {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof PlanTreeError, `expected PlanTreeError, got ${err}`);
		return;
	}
	assert.fail("expected PlanTreeError, but createTree succeeded");
}

describe("createTree — units", () => {
	// plan 001 part 1: when units is absent, the field stays absent.
	it("keeps units absent when not provided", () => {
		const t = createTree([N("a"), N("b")], [E("a", "b")]);
		assert.equal(t.units, undefined);
		assert.equal("units" in t, false);
	});

	// plan 001 part 1: copies units ({...u, nodeIds: [...u.nodeIds]}) and accepts same-unit and forward edges.
	it("stores deep-copied units and accepts same-unit and forward-unit edges", () => {
		const units = [U("u1", "Unit 1", ["a", "b"], "Ch. 1"), U("u2", "Unit 2", ["c"])];
		const t = createTree([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c")], units);
		assert.equal(t.version, 1);
		assert.deepEqual(t.units, [
			{ id: "u1", title: "Unit 1", source: "Ch. 1", nodeIds: ["a", "b"] },
			{ id: "u2", title: "Unit 2", nodeIds: ["c"] },
		]);

		// Mutating caller inputs must not affect the returned tree.
		units[0]!.nodeIds.push("c");
		units.push(U("u3", "Unit 3", []));
		assert.deepEqual(t.units?.length, 2);
		assert.deepEqual(t.units?.[0]?.nodeIds, ["a", "b"]);
	});

	// plan 001 part 1: unit ids are unique.
	it("rejects duplicate unit ids", () => {
		assertReject(() =>
			createTree([N("a"), N("b")], [], [U("u1", "First", ["a"]), U("u1", "Second", ["b"])]),
		);
	});

	// plan 001 part 1: unit ids are slug-valid.
	it("rejects invalid unit id slugs", () => {
		assertReject(() => createTree([N("a")], [], [U("Basics", "Basics", ["a"])]));
		assertReject(() => createTree([N("a")], [], [U("bad id", "Bad", ["a"])]));
		assertReject(() => createTree([N("a")], [], [U("", "Empty", ["a"])]));
	});

	// plan 001 part 1: unit ids are distinct from node ids.
	it("rejects unit id equal to a node id", () => {
		assertReject(() => createTree([N("alpha"), N("beta")], [], [U("alpha", "Alpha", ["alpha", "beta"])]));
	});

	// plan 001 part 1: unit titles are non-empty.
	it("rejects empty or whitespace-only unit title", () => {
		assertReject(() => createTree([N("a")], [], [U("u1", "", ["a"])]));
		assertReject(() => createTree([N("a")], [], [U("u1", "   ", ["a"])]));
	});

	// plan 001 part 1: every node is in exactly one unit (missing node or duplicate node).
	it("rejects when a node is missing from units or appears in multiple units", () => {
		assertReject(() => createTree([N("a"), N("b")], [], [U("u1", "U1", ["a"])]));
		assertReject(() =>
			createTree([N("a"), N("b")], [], [U("u1", "U1", ["a", "b"]), U("u2", "U2", ["b"])]),
		);
	});

	// plan 001 part 1: every unit nodeIds entry is a real node.
	it("rejects unit nodeIds referencing an unknown node", () => {
		assertReject(() => createTree([N("a")], [], [U("u1", "U1", ["a", "ghost"])]));
	});

	// plan 001 part 1: no edge's prerequisite sits in a later unit.
	it("rejects edge whose prerequisite sits in a later unit", () => {
		assertReject(() =>
			createTree([N("a"), N("b")], [E("b", "a")], [U("u1", "U1", ["a"]), U("u2", "U2", ["b"])]),
		);
	});
});
