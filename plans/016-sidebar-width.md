# 016 — A resizable sidebar that scales with the window

Status: **approved** 2026-11-24. Runs after plan 015 (both touch the sidebar area; 015 only its Files panel).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Part 1 through the light ladder (`ladder chunk --plan plans/016-sidebar-width.md --step "Part 1" --light`; owner's decision 2026-11-24). Build and install follow (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests the part names as updated. Texts marked **confirmed** are used verbatim.

## What this builds

The left sidebar is a fixed 288 px (`w-72`, `components/sidebar.tsx`), so session names, course file names and their chips are cut off. The learner wants to widen it by dragging, and its width should follow the window.

## Owner decisions (2026-11-24)

1. A drag handle on the sidebar's right edge. The dragged width is stored as a **share of the window width**, so the sidebar grows and shrinks with the window, clamped to a minimum and maximum. Remembered across restarts; double-click on the handle resets it.
2. The problem to solve is text cut off in the sidebar; the lesson area and the auto-close behaviour were not reported as problems.

## Spec-level choices (approved with this plan)

- **Width** = `clamp(round(share × window width), 240, min(560, window width − 640))` px. 640 px stays the lesson area's minimum (today's rule).
- **Default share** `0.2` (288 px at the default 1440 px window, as today).
- **Stored** in `localStorage` key `lh:sidebar-share`, read and written in try/catch like `lh:sidebar-open`; an invalid or missing value means the default.
- **Auto-close** stays, with the threshold lowered from 928 to **880** (240 + 640), in both `components/sidebar.tsx` and its mirror `electron/main.cjs` (`SIDEBAR_AUTOCLOSE`, also the `lh:expand-window` target).
- **Handle:** a 6 px hit area over the right border, `cursor: col-resize`, a faint highlight on hover and while dragging. Pointer drag with pointer capture; the share is updated live and saved on release. The width transition is off while dragging. It is a focusable `role="separator"` with `aria-orientation="vertical"`, `aria-valuenow/min/max` in px and `aria-label` **confirmed** `Resize sidebar`; ←/→ change the width by 16 px, Home resets. Double-click resets to the default share.
- The closed sidebar and the header toggle slot (`SidebarToggle`) are unchanged.

## Part 1 — Width model, handle, threshold

**Files.** New pure `components/sidebar-width.ts` (`sidebarWidth(share, windowWidth)`, `shareFor(widthPx, windowWidth)`, constants), `components/sidebar.tsx` (inline width from the model instead of `w-72` on both the motion wrapper and the inner column; the handle; threshold 880), `electron/main.cjs` (threshold 880). New tests: `tests/sidebar-width.test.ts`, `tests/sidebar-resize-handle.test.tsx`. Updated test: any existing test that asserts `928` or the `w-72` class (to be named by the implementer from a grep; only those assertions change).

**Tests.** Clamp at min, max and the 640 px lesson floor; default share at 1440 px gives 288; drag changes width live and saves the share on release; the width follows a window resize at a fixed share; keyboard ←/→/Home; double-click reset; storage throwing falls back to the default; auto-close at 879 px and open at 880 px; the Electron constant equals the renderer's.

## Last stage — build and install (after the queue, not a ladder part)

`npm run desktop:dist`, ask the owner to quit the app, replace `/Applications/LearnHarness.app`.

## Status per part

| Part | Status |
|---|---|
| 1 Width model, handle, threshold | green (light), build-review/20261124-161940-016-part-1 + fix build-review/20261124-163557-016-part-1; final gate failed only on the flaky session-find-header Esc test, 5/5 alone and full suite green on recheck |
| Build and install | installed 2026-11-24 16:48 |
