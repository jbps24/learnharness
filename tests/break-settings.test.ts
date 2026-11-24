import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BREAK_DEFAULTS,
	BREAK_INTERVAL_RANGE,
	BREAK_LENGTH_RANGE,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { parseBreaksSettingsBody, SETTINGS_SECTIONS } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { breakTimings } from "../src/core/breaks.ts";

describe("break settings constants", () => {
	// plan 002 part 1: BREAK_DEFAULTS and bounds constants
	it("exports BREAK_DEFAULTS, BREAK_INTERVAL_RANGE, and BREAK_LENGTH_RANGE with plan values", () => {
		assert.deepEqual(BREAK_DEFAULTS, { enabled: true, intervalMinutes: 45, lengthMinutes: 10 });
		assert.deepEqual(BREAK_INTERVAL_RANGE, { min: 20, max: 90, step: 5 });
		assert.deepEqual(BREAK_LENGTH_RANGE, { min: 5, max: 20, step: 1 });
	});
});

describe("sanitizeUserSettings breaks", () => {
	// plan 002 part 1: sanitizeUserSettings({ version: 1, breaks: { enabled: false, intervalMinutes: 47, lengthMinutes: 3.6 } }) gives breaks: { enabled: false, intervalMinutes: 45, lengthMinutes: 5 }
	it("sanitizes plan example { enabled: false, intervalMinutes: 47, lengthMinutes: 3.6 }", () => {
		const out = sanitizeUserSettings({
			version: 1,
			breaks: { enabled: false, intervalMinutes: 47, lengthMinutes: 3.6 },
		});
		assert.deepEqual(out?.breaks, { enabled: false, intervalMinutes: 45, lengthMinutes: 5 });
	});

	// plan 002 part 1: enabled is boolean or dropped
	it("keeps boolean enabled and drops non-boolean enabled", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { enabled: true } })?.breaks, { enabled: true });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { enabled: false } })?.breaks, { enabled: false });
		for (const bad of ["true", 1, 0, null, [], {}]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { enabled: bad } })?.breaks, {});
		}
	});

	// plan 002 part 1: intervalMinutes finite number clamped to [20, 90] then rounded to nearest multiple of 5 (200 -> 90; "x" dropped)
	it("clamps intervalMinutes to [20, 90] and rounds to nearest multiple of 5; drops non-finite and non-numbers", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 200 } })?.breaks, { intervalMinutes: 90 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 91 } })?.breaks, { intervalMinutes: 90 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 90 } })?.breaks, { intervalMinutes: 90 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 20 } })?.breaks, { intervalMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 0 } })?.breaks, { intervalMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: -10 } })?.breaks, { intervalMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 22 } })?.breaks, { intervalMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 23 } })?.breaks, { intervalMinutes: 25 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: 48 } })?.breaks, { intervalMinutes: 50 });

		for (const bad of ["x", "45", NaN, Infinity, -Infinity, null, true, []]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { intervalMinutes: bad } })?.breaks, {});
		}
	});

	// plan 002 part 1: lengthMinutes clamped to [5, 20] then rounded to integer; anything else dropped
	it("clamps lengthMinutes to [5, 20] and rounds to integer; drops non-finite and non-numbers", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 0 } })?.breaks, { lengthMinutes: 5 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: -5 } })?.breaks, { lengthMinutes: 5 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 5 } })?.breaks, { lengthMinutes: 5 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 20 } })?.breaks, { lengthMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 21 } })?.breaks, { lengthMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 100 } })?.breaks, { lengthMinutes: 20 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 10.4 } })?.breaks, { lengthMinutes: 10 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: 10.6 } })?.breaks, { lengthMinutes: 11 });

		for (const bad of ["x", "10", NaN, Infinity, -Infinity, null, false, {}]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: { lengthMinutes: bad } })?.breaks, {});
		}
	});

	// plan 002 part 1: empty breaks object
	it("preserves empty breaks object", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, breaks: {} })?.breaks, {});
	});
});

describe("resolveSettings breaks", () => {
	// plan 002 part 1: resolveSettings(null).breaks equals { enabled: true, intervalMinutes: 45, lengthMinutes: 10 }
	it("resolves null record to BREAK_DEFAULTS", () => {
		assert.deepEqual(resolveSettings(null).breaks, {
			enabled: true,
			intervalMinutes: 45,
			lengthMinutes: 10,
		});
	});

	// plan 002 part 1: EffectiveSettings.breaks filled from the record over BREAK_DEFAULTS
	it("fills missing and partial breaks from BREAK_DEFAULTS and honors explicit values", () => {
		assert.deepEqual(resolveSettings({ version: 1 }).breaks, {
			enabled: true,
			intervalMinutes: 45,
			lengthMinutes: 10,
		});
		assert.deepEqual(resolveSettings({ version: 1, breaks: {} }).breaks, {
			enabled: true,
			intervalMinutes: 45,
			lengthMinutes: 10,
		});
		assert.deepEqual(resolveSettings({ version: 1, breaks: { enabled: false } }).breaks, {
			enabled: false,
			intervalMinutes: 45,
			lengthMinutes: 10,
		});
		assert.deepEqual(resolveSettings({ version: 1, breaks: { intervalMinutes: 60 } }).breaks, {
			enabled: true,
			intervalMinutes: 60,
			lengthMinutes: 10,
		});
		assert.deepEqual(
			resolveSettings({
				version: 1,
				breaks: { enabled: false, intervalMinutes: 30, lengthMinutes: 15 },
			}).breaks,
			{ enabled: false, intervalMinutes: 30, lengthMinutes: 15 },
		);
	});
});

describe("breakTimings", () => {
	const MIN = 60_000;

	// plan 002 part 1: breakTimings({ intervalMinutes: 45, lengthMinutes: 10 }) gives lead 5, escalate 20, reoffer 20 (min); lengthMs = 600 000 at 10
	it("computes timings at default 45/10", () => {
		assert.deepEqual(breakTimings({ intervalMinutes: 45, lengthMinutes: 10 }), {
			intervalMs: 45 * MIN,
			lengthMs: 600_000,
			leadMs: 5 * MIN,
			escalateMs: 20 * MIN,
			reofferMs: 20 * MIN,
		});
	});

	// plan 002 part 1: At 20 -> 2/9/9
	it("computes timings at minimum interval 20", () => {
		assert.deepEqual(breakTimings({ intervalMinutes: 20, lengthMinutes: 5 }), {
			intervalMs: 20 * MIN,
			lengthMs: 5 * MIN,
			leadMs: 2 * MIN,
			escalateMs: 9 * MIN,
			reofferMs: 9 * MIN,
		});
	});

	// plan 002 part 1: At 90 -> 10/40/40
	it("computes timings at maximum interval 90", () => {
		assert.deepEqual(breakTimings({ intervalMinutes: 90, lengthMinutes: 20 }), {
			intervalMs: 90 * MIN,
			lengthMs: 20 * MIN,
			leadMs: 10 * MIN,
			escalateMs: 40 * MIN,
			reofferMs: 40 * MIN,
		});
	});
});

describe("PUT /api/settings/breaks parser", () => {
	const parse = SETTINGS_SECTIONS.breaks;

	it("is registered as a settings section", () => {
		assert.equal(parse, parseBreaksSettingsBody);
	});

	it("accepts valid bodies", () => {
		assert.deepEqual(parse({}), { ok: true, settings: {} });
		assert.deepEqual(parse({ enabled: false, intervalMinutes: 45, lengthMinutes: 10, extra: 1 }), {
			ok: true,
			settings: { enabled: false, intervalMinutes: 45, lengthMinutes: 10 },
		});
		assert.equal(parse({ intervalMinutes: 20, lengthMinutes: 20 }).ok, true);
		assert.equal(parse({ intervalMinutes: 90, lengthMinutes: 5 }).ok, true);
	});

	it("rejects invalid bodies", () => {
		for (const body of [
			null,
			"x",
			[1],
			{ enabled: "yes" },
			{ intervalMinutes: "45" },
			{ intervalMinutes: 200 },
			{ intervalMinutes: 15 },
			{ intervalMinutes: 47 },
			{ intervalMinutes: 22.5 },
			{ lengthMinutes: 3 },
			{ lengthMinutes: 21 },
			{ lengthMinutes: 10.5 },
			{ lengthMinutes: "10" },
		]) {
			assert.equal(parse(body).ok, false, JSON.stringify(body));
		}
	});
});
