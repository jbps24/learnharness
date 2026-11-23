import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { assignmentTargets } from "../src/core/course-assign.ts";

function makeTree(nodes: PlanTree["nodes"], version = 1): PlanTree {
	return { nodes, edges: [], version };
}

describe("assignmentTargets", () => {
	// plan 007 part 3: trigger 1 — added assignable binding file when a tree exists targets all nodes
	it("targets all nodes for an added assignable binding file when a tree exists", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		};
		const tree = makeTree([
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
		]);
		const res = assignmentTargets({ kind: "added", material, added: ["/course/a.pdf"], tree });
		assert.deepEqual(res.targets, [{ path: "/course/a.pdf", nodeIds: ["n1", "n2"] }]);
	});

	// plan 007 part 3: trigger 1 — added non-assignable or unticked (binding: false) file is not targeted
	it("skips non-assignable and unticked files in added", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/pic.png", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "not-assignable" },
				{ path: "/course/unticked.md", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: false, status: "pending" },
			],
			methods: [],
			conflicts: [],
		};
		const tree = makeTree([{ id: "n1", title: "Node 1" }]);
		const res = assignmentTargets({
			kind: "added",
			material,
			added: ["/course/pic.png", "/course/unticked.md"],
			tree,
		});
		assert.deepEqual(res.targets, []);
	});

	// plan 007 part 3: trigger 3 — file added while no tree exists stays pending and produces no targets
	it("produces no targets when added before any tree exists", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
			],
			methods: [],
			conflicts: [],
		};
		const res = assignmentTargets({ kind: "added", material, added: ["/course/a.pdf"], tree: undefined });
		assert.deepEqual(res.targets, []);
		assert.equal(res.material.files[0]?.status, "pending");
	});

	// plan 007 part 3: trigger 3 — file added before any tree is assigned at the first plan_init
	it("picks up pending binding files at the first plan_init", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "pending" },
				{ path: "/course/pic.png", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "not-assignable" },
			],
			methods: [],
			conflicts: [],
		};
		const nextTree = makeTree([
			{ id: "n1", title: "Node 1" },
			{ id: "n2", title: "Node 2" },
		]);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree: undefined, nextTree });
		assert.deepEqual(res.targets, [{ path: "/course/a.pdf", nodeIds: ["n1", "n2"] }]);
	});

	// plan 007 part 3: trigger 2 — rewrite that renames one node's title targets only that node
	it("targets only the node whose title changed on a plan_init rewrite", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
		};
		const previousTree = makeTree([
			{ id: "n1", title: "Old title", summary: "Same" },
			{ id: "n2", title: "Unchanged", summary: "Same" },
		], 1);
		const nextTree = makeTree([
			{ id: "n1", title: "New title", summary: "Same" },
			{ id: "n2", title: "Unchanged", summary: "Same" },
		], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.targets, [{ path: "/course/a.pdf", nodeIds: ["n1"] }]);
	});

	// plan 007 part 3: trigger 2 — rewrite that changes a node's summary or adds a new node targets only changed/new nodes
	it("targets new nodes and nodes whose summary changed on a plan_init rewrite", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [],
			conflicts: [],
		};
		const previousTree = makeTree([
			{ id: "n1", title: "Same", summary: "Old summary" },
			{ id: "n2", title: "Unchanged", summary: "Same" },
		], 1);
		const nextTree = makeTree([
			{ id: "n1", title: "Same", summary: "New summary" },
			{ id: "n2", title: "Unchanged", summary: "Same" },
			{ id: "n3", title: "Brand new" },
		], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.targets, [{ path: "/course/a.pdf", nodeIds: ["n1", "n3"] }]);
	});

	// plan 007 part 3: trigger 2 — rewrite skips unticked (binding: false) and not-assignable files
	it("skips unticked and non-assignable files on plan_init rewrite", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/unticked.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: false, status: "assigned" },
				{ path: "/course/pic.png", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "not-assignable" },
			],
			methods: [],
			conflicts: [],
		};
		const previousTree = makeTree([{ id: "n1", title: "Old" }], 1);
		const nextTree = makeTree([{ id: "n1", title: "New" }], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.targets, []);
	});

	// plan 007 part 3: trigger 2 — removed node's methods and conflict disappear right away
	it("drops methods and conflicts of nodes removed from the tree right away", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
				{ path: "/course/b.pdf", addedAt: "2026-11-22T00:01:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/a.pdf", method: "Keep" },
				{ nodeId: "removed", path: "/course/a.pdf", method: "Drop A" },
				{ nodeId: "removed", path: "/course/b.pdf", method: "Drop B" },
			],
			conflicts: [
				{ nodeId: "removed", paths: ["/course/a.pdf", "/course/b.pdf"] },
			],
		};
		const previousTree = makeTree([
			{ id: "n1", title: "Keep" },
			{ id: "removed", title: "Removed" },
		], 1);
		const nextTree = makeTree([{ id: "n1", title: "Keep" }], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.material.methods, [{ nodeId: "n1", path: "/course/a.pdf", method: "Keep" }]);
		assert.deepEqual(res.material.conflicts, []);
		assert.deepEqual(res.targets, []);
	});

	// plan 007 part 3: trigger 2 — a conflict left with fewer than two paths is dropped
	it("drops any conflict left with fewer than two paths", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigned" },
			],
			methods: [{ nodeId: "n1", path: "/course/a.pdf", method: "Method A" }],
			conflicts: [{ nodeId: "n1", paths: ["/course/a.pdf"] }],
		};
		const previousTree = makeTree([{ id: "n1", title: "Keep" }], 1);
		const nextTree = makeTree([{ id: "n1", title: "Keep" }], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.material.conflicts, []);
	});

	it("targets changed and new nodes for binding files currently assigning on plan_init", () => {
		const material: CourseMaterial = {
			files: [
				{ path: "/course/a.pdf", addedAt: "2026-11-22T00:00:00.000Z", via: "learner", binding: true, status: "assigning" },
			],
			methods: [],
			conflicts: [],
		};
		const previousTree = makeTree([{ id: "n1", title: "Old" }], 1);
		const nextTree = makeTree([
			{ id: "n1", title: "New" },
			{ id: "n2", title: "Added" },
		], 2);
		const res = assignmentTargets({ kind: "plan_init", material, previousTree, nextTree });
		assert.deepEqual(res.targets, [{ path: "/course/a.pdf", nodeIds: ["n1", "n2"] }]);
	});
});
