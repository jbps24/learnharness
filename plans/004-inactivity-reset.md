# 004 — Reset after inactivity: its own break setting, and a running answer counts as activity

Status: **approved** 2026-11-22.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the part through the ladder (`execute-plan` skill): `ladder chunk --plan plans/004-inactivity-reset.md --step "Part 1"`.
3. After the part is green, update "Status per part" below.

## What this changes

Plan 002 uses the **break length** for two things: how long the break countdown runs, and how long a gap without activity must be before the learning clock resets (the learner counts as away, the teacher gets the away note, an open break offer counts as skipped). This plan gives the second one its own setting, **Reset after inactivity** (`breaks.resetMinutes`). The break length then only sets the countdown.

It also fixes a display bug. While a learner-triggered answer is still streaming, the client measures the gap from the learner's last input, so an answer that runs longer than the threshold shows the clock at 0 and an open offer as skipped before the answer has finished.

## Owner decisions (2026-11-22)

1. Label **Reset after inactivity**, field `breaks.resetMinutes`.
2. Default **15**, range **5–60**, whole minutes (step 1).
3. A running answer counts as activity. The gap starts when it ends.
4. The row is always visible in Settings > Agent > Breaks, also when break suggestions are off, because the reset and the away note apply either way.

## Part 1 — The reset setting and the running-answer fix

**Settings.**
- `src/core/settings.ts`: `BreakSettings` gains `resetMinutes?: number`. `BREAK_DEFAULTS` gains `resetMinutes: 15`. New `BREAK_RESET_RANGE = { min: 5, max: 60, step: 1 } as const`. `sanitizeBreaks` clamps and rounds `resetMinutes` like `lengthMinutes` (a non-number or non-finite value is dropped).
- `src/core/settings-resolution.ts`: the resolved `breaks` gains `resetMinutes: number`, read as `record?.breaks?.resetMinutes ?? BREAK_DEFAULTS.resetMinutes`.
- `src/server/settings-body.ts`, `parseBreaksSettingsBody`: accepts `resetMinutes`, strict: an integer from 5 to 60, else `{ ok: false, error: "resetMinutes must be an integer between 5 and 60" }`. The doc comment lists the new field.
- `components/settings/agent-section.tsx`, Breaks group: a third row after Break length, outside the `resolvedBreaks.enabled &&` block so it always shows. `SettingsRow` label `Reset after inactivity`, hint `minutes without activity before the learning clock restarts (5–60)`, testid `breaks-row-reset`. `CommitInput` `type="number"`, ariaLabel `reset after inactivity`, testid `input-breaks-reset`, value `resolvedBreaks.resetMinutes`. On commit it follows the length row: empty or non-finite input writes nothing; otherwise clamp to `BREAK_RESET_RANGE` and round, then call `onBreaksChange({ ...breaks, resetMinutes })`.

**Clock.**
- `src/core/breaks.ts`: `breakTimings` takes `{ intervalMinutes; lengthMinutes; resetMinutes }`. `BreakTimings` gains `resetMs = resetMinutes × 60 000`. `lengthMs` stays.
- Every inactivity check uses `resetMs` instead of `lengthMs`: the `replayClock` threshold parameter (renamed `resetMs`), and the call sites in `learningClock` (~l.167–168) and `breakState` (~l.193, ~l.252). Nothing else changes in `breakState`.
- `replayClock` also returns its final `trigger` (`"learner" | "automatic" | null`).
- `learningClock` gets an optional fifth parameter `opts?: { turnRunning?: boolean }`. When `turnRunning` is true and the final trigger is `"learner"`, `activityEnd` becomes `max(activityEnd, now)` before the away check. So a learner-triggered turn still running at `now` gives `awayMs: null`, and `learningMs = now − startedAt`. An automatically triggered running turn (final trigger `"automatic"`) changes nothing, the same as plan 002's rule that automatic turns never extend activity.
- `src/core/breaks.ts`, `dividerState`: unchanged. Its `away` input comes from the client as below.

**Callers.**
- `src/core/input-events.ts` (~l.357) and `src/core/view.ts` (~l.389) build their timings from `breakTimings(BREAK_DEFAULTS)` instead of the `{ intervalMinutes: 45, lengthMinutes: 10 }` literal. Both only read `latest`, so the reset value changes nothing for them.
- `app/api/chats/[id]/break/route.ts`, `src/agent/tools/breaks.ts`, `src/server/chat-handler.ts`: already pass the resolved settings to `breakTimings`, which now carry `resetMinutes`. No other change. The server never evaluates the clock while a turn runs (inputs start turns; the break route refuses with 409 while a turn runs), so it needs no `turnRunning`.
- `components/chat.tsx` (~l.1152–1165): both `learningClock` calls pass `{ turnRunning: localStream || turnInFlight }` and add both flags to the `useMemo` deps. A running turn then keeps the minutes counting and keeps an open divider from turning into skipped.

**Docs.**
- `CONTEXT.md`, the learning-clock entry (~l.31): "at least as long as the break length" becomes "at least as long as the reset after inactivity". Add a short **Reset after inactivity** entry next to **Break length**: the gap without learner activity after which the learning clock restarts and the learner counts as away; a learner-triggered answer still running counts as activity.
- `docs/architecture.md`, break flow steps 1 and 4: "a gap of at least the break length" and "(the length of a break, with no activity)" name the reset after inactivity instead. Settings list: interval, length, reset, enabled.
- `plans/002-learning-breaks.md`, choice 11: add one line, "Superseded by plan 004: the threshold is `breaks.resetMinutes`."

**Tests** (new file `tests/break-inactivity-reset.test.ts`, plus the settings-section style of `tests/break-settings-section.test.tsx` for the row):
- `breakTimings({ intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 }).resetMs` → 900 000; `lengthMs` stays 600 000.
- With length 10 and reset 15: a 12-min gap between learner actions does not reset the clock; a 15-min gap does. `learningClock` at `now` = activity end + 14 min 59 s gives `awayMs: null`; at + 15 min, `awayMs` 15 min and `learningMs` 0.
- `breakState` with an open offer: the outcome is `"pending"` at activity end + 14 min 59 s and `"skipped"` at + 15 min (reset 15, length 10).
- Running turn: a learner action at 0, no reply yet, `now` = 20 min, reset 15. Without `opts` → `awayMs` 20 min. With `{ turnRunning: true }` → `awayMs: null`, `learningMs` 20 min. Same transcript whose last trigger is an automatic wake at 2 (learner action at 0), `now` 20, `turnRunning: true` → `awayMs` 20 min.
- Settings: `sanitizeBreaks` with `resetMinutes` 3 → 5, 75 → 60, 12.4 → 12, `"x"` → dropped. Resolution without the field → 15. `parseBreaksSettingsBody({ resetMinutes: 4 })`, `61` and `12.5` → the error text above; `30` → ok.
- Settings row: shows with suggestions on and off; committing `30` calls `onBreaksChange` with `resetMinutes: 30` and the other fields kept; committing `""` writes nothing; `90` is clamped to 60.
- Existing tests that build timings from `{ intervalMinutes, lengthMinutes }` get `resetMinutes` equal to their `lengthMinutes`, so their expectations hold unchanged.

---

## Status per part

| Part | Status | Build id |
|---|---|---|
| 1 Reset setting and running-answer fix | green 2026-11-22 (run 20261122-101547-004-part-1; fix round 20261122-113157-004-part-1: CONTEXT.md break length) | - |
