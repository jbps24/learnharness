import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_SIDEBAR_SHARE,
	LESSON_MIN_WIDTH,
	SIDEBAR_AUTOCLOSE,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	shareFor,
	sidebarWidth,
} from "../components/sidebar-width.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("sidebar width model", () => {
	// plan 016 part 1: default share at 1440 px gives 288
	it("computes 288 px from the default share at 1440 px", () => {
		assert.ok(DEFAULT_SIDEBAR_SHARE > 0);
		assert.equal(sidebarWidth(DEFAULT_SIDEBAR_SHARE, 1440), 288);
		assert.equal(shareFor(288, 1440), DEFAULT_SIDEBAR_SHARE);
	});

	// plan 016 part 1: Clamp at min
	it("clamps narrow shares to SIDEBAR_MIN_WIDTH", () => {
		assert.ok(SIDEBAR_MIN_WIDTH > 0);
		assert.equal(sidebarWidth(0.01, 1440), SIDEBAR_MIN_WIDTH);
		assert.equal(sidebarWidth(0, 1440), SIDEBAR_MIN_WIDTH);
	});

	// plan 016 part 1: Clamp at max
	it("clamps wide shares to SIDEBAR_MAX_WIDTH", () => {
		assert.ok(SIDEBAR_MAX_WIDTH > SIDEBAR_MIN_WIDTH);
		assert.equal(sidebarWidth(0.99, 2000), SIDEBAR_MAX_WIDTH);
		assert.equal(sidebarWidth(1, 2000), SIDEBAR_MAX_WIDTH);
	});

	// plan 016 part 1: Clamp at the 640 px lesson floor
	it("clamps width to preserve the 640 px lesson floor", () => {
		assert.equal(LESSON_MIN_WIDTH, 640);
		assert.equal(sidebarWidth(0.5, 900), 900 - 640);
		assert.equal(sidebarWidth(0.5, 880), 880 - 640);
	});

	// plan 016 part 1: the width follows a window resize at a fixed share
	it("scales the width proportionally when the window resizes at a fixed share", () => {
		const share = shareFor(360, 1200);
		assert.equal(share, 0.3);
		assert.equal(sidebarWidth(share, 1200), 360);
		assert.equal(sidebarWidth(share, 1000), 300);
		assert.equal(sidebarWidth(share, 1400), 420);
	});

	// plan 016 part 1: the Electron constant equals the renderer's
	it("keeps electron/main.cjs SIDEBAR_AUTOCLOSE equal to the renderer's 880", () => {
		const mainSource = fs.readFileSync(path.join(REPO_ROOT, "electron", "main.cjs"), "utf8");
		const match = /const\s+SIDEBAR_AUTOCLOSE\s*=\s*(\d+)\s*;/.exec(mainSource);
		assert.ok(match, "SIDEBAR_AUTOCLOSE constant present in electron/main.cjs");
		assert.equal(Number(match[1]), 880);
		assert.equal(Number(match[1]), SIDEBAR_AUTOCLOSE);
	});
});
