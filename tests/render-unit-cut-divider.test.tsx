import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { UnitCutDivider, type UnitCutDividerData } from "../components/compaction-divider.tsx";

const data: UnitCutDividerData = {
	unitIndex: 2,
	title: "Derivatives",
};

describe("UnitCutDivider", () => {
	// plan 001 part 8: UnitCutDivider with same geometry as CompactionCutDivider, label Unit <n> · <title>, data-testid="unit-cut-divider"
	it("renders data-testid, Unit <n> · <title> label, and dotted-rule geometry", () => {
		const html = renderToStaticMarkup(<UnitCutDivider data={data} />);
		assert.ok(html.includes('data-testid="unit-cut-divider"'));
		assert.ok(html.includes("Unit 2 · Derivatives"));
		assert.ok(html.includes("border-t-2 border-dotted"));
	});

	// plan 001 part 8: UnitCutDivider is inert
	it("is inert — plain markup, no button or click affordance", () => {
		const html = renderToStaticMarkup(<UnitCutDivider data={data} />);
		assert.ok(!html.includes("<button"));
		assert.ok(!html.includes("cursor-pointer"));
	});
});
