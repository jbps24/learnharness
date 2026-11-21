import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
const renderToStaticMarkup = (node: ReactNode) => renderMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanBlock, PlanPopup, blockLayout, type PopupMessage } from "../components/plan-block.tsx";
import {
	LESSON_RECORD_HEADER,
	type LhMarkerMessage,
	type LhMessage,
	type PlanBlockData,
	type PlanTree,
} from "../src/core/index.ts";
import { planBlocksFor } from "../src/core/plan-blocks.ts";

const UNIT_TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha" },
		{ id: "b", title: "Beta" },
		{ id: "c", title: "Gamma" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	units: [
		{ id: "u1", title: "Foundations", nodeIds: ["a", "b"] },
		{ id: "u2", title: "Applications", nodeIds: ["c"] },
	],
	version: 1,
};

type ClusterBox = {
	x: number;
	y: number;
	w: number;
	h: number;
	style: string;
	contains: (html: string, id: string, layout?: ReturnType<typeof blockLayout>) => boolean;
};

/** Rounded (rx) rects in the markup, with geometry parsed and the rest kept as `style`. */
function clusterBoxes(html: string): ClusterBox[] {
	const out: ClusterBox[] = [];
	for (const m of html.matchAll(/<rect[^>]*\srx="[^>]*>/g)) {
		const tag = m[0];
		const num = (k: string) => Number(new RegExp(`\\s${k}="(-?[\\d.]+)"`).exec(tag)?.[1]);
		const box = {
			x: num("x"),
			y: num("y"),
			w: num("width"),
			h: num("height"),
			style: tag.replace(/\s(x|y|width|height)="[^"]*"/g, ""),
		};
		out.push({
			...box,
			contains(h, id, layout) {
				const t = new RegExp(`translate\\((-?[\\d.]+),\\s*(-?[\\d.]+)\\)"[^>]*data-testid="plan-node-${id}"`).exec(h);
				if (!t) return false;
				const nx = Number(t[1]);
				const ny = Number(t[2]);
				const nw = layout?.nodeW.get(id) ?? 1;
				const nh = layout?.nodeH.get(id) ?? 1;
				return nx >= box.x && ny >= box.y && nx + nw <= box.x + box.w && ny + nh <= box.y + box.h;
			},
		});
	}
	return out;
}

describe("plan block units", () => {
	// plan 001 part 8: no units -> today's layout, unchanged
	it("produces an identical layout when units are omitted, undefined, or empty", () => {
		const baseline = blockLayout(UNIT_TREE.nodes, UNIT_TREE.edges);
		const withUndefined = blockLayout(UNIT_TREE.nodes, UNIT_TREE.edges, undefined);
		const withEmpty = blockLayout(UNIT_TREE.nodes, UNIT_TREE.edges, []);
		for (const other of [withUndefined, withEmpty]) {
			assert.deepEqual(other.x, baseline.x);
			assert.deepEqual(other.y, baseline.y);
			assert.deepEqual(other.nodeW, baseline.nodeW);
			assert.deepEqual(other.nodeH, baseline.nodeH);
			assert.deepEqual(other.edgePts, baseline.edgePts);
			assert.equal(other.width, baseline.width);
			assert.equal(other.height, baseline.height);
			assert.equal(other.originX, baseline.originX);
			assert.equal(other.originY, baseline.originY);
		}
	});

	// plan 001 part 8: compound dagre graph with one cluster per unit drawn as a rounded box with the unit title top-left
	it("renders one rounded cluster box per unit with its title", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-11-20T00:00:00.000Z",
			current: null,
			nodes: UNIT_TREE.nodes.map((n) => ({ id: n.id, title: n.title, status: "upcoming" })),
			edges: UNIT_TREE.edges,
			units: UNIT_TREE.units,
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.ok(html.includes("Foundations"));
		assert.ok(html.includes("Applications"));
		const roundedRects = html.match(/<rect[^>]*\srx="/g) ?? [];
		assert.equal(roundedRects.length, 2, "one rounded cluster rect per unit");
	});

	// plan 001 part 8: one cluster per unit containing exactly its nodes
	it("each unit cluster box contains exactly its own nodes", () => {
		const layout = blockLayout(UNIT_TREE.nodes, UNIT_TREE.edges, UNIT_TREE.units);
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-11-20T00:00:00.000Z",
			current: null,
			nodes: UNIT_TREE.nodes.map((n) => ({ id: n.id, title: n.title, status: "upcoming" })),
			edges: UNIT_TREE.edges,
			units: UNIT_TREE.units,
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		const boxes = clusterBoxes(html);
		assert.equal(boxes.length, 2);
		const owner = (id: string) => boxes.filter((b) => b.contains(html, id, layout));
		for (const id of ["a", "b", "c"]) assert.equal(owner(id).length, 1, `node ${id} in exactly one cluster`);
		assert.equal(owner("a")[0], owner("b")[0], "a and b share u1's cluster");
		assert.notEqual(owner("a")[0], owner("c")[0], "c is in a different cluster");
	});

	// plan 001 part 8: full-block snapshot carries units from the tree unchanged
	it("planBlocksFor carries units from the tree on the snapshot", () => {
		const call: LhMessage = {
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "plan_init", arguments: {} }],
			timestamp: 1,
		} as never;
		const result: LhMessage = {
			id: "r1",
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "plan_init",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true, tree: UNIT_TREE },
			isError: false,
			timestamp: 2,
		} as never;
		const markers = planBlocksFor([], [result], UNIT_TREE, [call, result]);
		assert.equal(markers.length, 1);
		const block = (markers[0] as LhMarkerMessage & { details: { block: PlanBlockData } }).details.block;
		assert.deepEqual(block.units, UNIT_TREE.units);
	});

	// plan 001 part 8: PlanPopup marks finished unit boxes and their nodes muted and gives the current unit box the emphasis stroke
	it("live overlay marks finished units muted and emphasizes the current unit", () => {
		const popupMessages: PopupMessage[] = [
			{
				parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: UNIT_TREE } }],
			},
			{
				parts: [{ type: "tool-quiz", state: "input-available", input: { nodeId: "c" } }],
			},
		];
		const nativeMessages: LhMessage[] = [
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "plan_init",
				content: [{ type: "text", text: "ok" }],
				details: { ok: true, tree: UNIT_TREE },
				isError: false,
				timestamp: 1,
			} as never,
			{
				id: "lr1",
				role: "custom",
				customType: "lesson-record",
				content: LESSON_RECORD_HEADER,
				display: false,
				details: {
					firstKeptMessageId: "a_cur",
					finishedUnitIds: ["u1"],
					currentUnitId: "u2",
					judgment: { learnerWide: "", commitments: "", nodes: {} },
					at: "2026-11-20T00:00:00.000Z",
				},
				timestamp: 2,
			},
			{
				id: "a_cur",
				role: "assistant",
				content: [{ type: "toolCall", id: "q_c", name: "quiz", arguments: { nodeId: "c" } }],
				timestamp: 3,
			} as never,
		];
		const html = renderToStaticMarkup(
			<PlanPopup messages={popupMessages} nativeMessages={nativeMessages} onClose={() => {}} />,
		);
		assert.ok(html.includes("Foundations"));
		assert.ok(html.includes("Applications"));
		assert.match(html, /opacity-\d+|opacity="0?\.\d+"/, "finished unit renders muted");
		const boxes = clusterBoxes(html);
		const u1Box = boxes.find((b) => b.contains(html, "a"))!;
		const u2Box = boxes.find((b) => b.contains(html, "c"))!;
		assert.ok(u1Box && u2Box);
		assert.notEqual(u2Box.style, u1Box.style, "current unit box is styled differently from the finished one");
	});
});
