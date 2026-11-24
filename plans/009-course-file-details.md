# 009 — Course file details: short rows, a details dialog

Status: **approved** 2026-11-23.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts through the ladder (`execute-plan` skill): `ladder queue --plan plans/009-course-file-details.md --step "Part 1" --step "Part 2"`.
3. After each part is green, update "Status per part" below.
4. Rules for every part: existing tests keep passing unchanged, except the tests a part names as updated. New test helpers only; do not reuse existing fixtures.

## What this changes

Plan 007 Part 7 lists, under each course file in the sidebar, every plan node the file supplied a method for. For the Regelungssysteme Skript that is 16 lines under one file. The owner wants the rows short and the details on demand (2026-11-23):

- A row shows only the tick, the file name, the status, a ⚠ when one of its nodes has an unresolved route conflict, and an ⓘ button.
- Clicking the file name still opens the file (desktop) or copies its path (browser), as today.
- The ⓘ button opens a centered dialog with the details: per plan node the file is used for, the node title, the pages and the stored course method text.

## Owner decisions (2026-11-23)

1. The name opens the file; a separate ⓘ icon opens the details.
2. The dialog shows node title, pages and method text per node, conflicts marked ⚠.
3. A centered dialog (the app's `HostDialog`), scrollable, closed by Esc, a click outside or a close button.
4. Every row has ⓘ, also for files not assigned yet; the dialog then shows the path and the status (and the error for a failed file).
5. The row keeps a ⚠ when one of the file's nodes has an unresolved conflict.
6. In a practice session the dialog shows the inherited methods with their node titles, looked up in each method's lesson.

## Part 1 — Route: node titles for a practice session's inherited methods

**Files.**
- `app/api/chats/[id]/course/route.ts` (GET).
- New test: `tests/course-route-lesson-nodes.test.ts`.

**Behavior.**
- GET keeps `{ material, nodes }` and adds `lessonNodes: Array<{ lessonId: string; id: string; title: string }>`.
- `lessonNodes` is empty unless the record is a practice session (`kind === "practice"`) whose `material.propositionMethods` is non-empty.
- For a practice session: for each distinct `lessonId` in `propositionMethods`, read that lesson's record once (`chatStore.getChat`), and add `{ lessonId, id, title }` for every node of its `tree` whose id occurs as a `nodeId` of a proposition method with that `lessonId`. A lesson that no longer exists, has no tree, or lacks the node adds nothing (no error).
- Order: by `lessonId` in first-occurrence order in `propositionMethods`, then the lesson tree's node order.

**Tests.**
- A practice record with proposition methods from two lessons gets the titles of exactly the referenced nodes, in the order above.
- A proposition method whose lesson is deleted, or whose node is not in the lesson's tree, adds nothing; the other titles are still returned.
- A teaching record gets `lessonNodes: []`, and `nodes` is unchanged.

## Part 2 — Panel rows and the details dialog

**Files.**
- `components/session-course-files.tsx`.
- New `components/course-file-details-dialog.tsx`.
- Updated tests: `tests/session-course-files.test.tsx` (its node-list-under-the-row assertions move to the dialog), `tests/sidebar-course-files.test.tsx` where it asserts node titles in the row.
- New test: `tests/course-file-details-dialog.test.tsx`.

**Row** (in this order): checkbox (unchanged), file name button (unchanged: opens or copies the path, the "Path copied" / "Could not copy the path" hint), status chip (unchanged, failed error as its tooltip), `from lesson` for `via === "inherited"` (unchanged), ⚠ with the tooltip `Your tutor will ask which route your course uses.` when an unresolved conflict (`chosen === undefined`) of a node this file supplied a method for includes this file's path, then an ⓘ button (lucide `InfoIcon`, `size-3`, `aria-label` `Details for <file name>`, `data-testid="course-file-details"`). No node list under the row any more.

**Dialog** (`CourseFileDetailsDialog`, built on `HostDialog` like `components/delete-session-dialog.tsx`; one dialog per panel, opened for one file):
- Header: the file name (`filePathLabel`) as the heading; below it the full path, muted, selectable.
- Status line: `Status: <label>` with the panel's labels (`waiting`, `reading…`, `assigned`, `failed`, `not assignable`); for `failed` also the error text; for `inherited` also `from lesson`.
- Body, teaching session, status `assigned`: `Used for <n> plan nodes:` (`1 plan node` singular), then one block per method of this file whose node is in `nodes`, in plan-map order: the node title (bold), the pages after it when present, ⚠ with the conflict tooltip when that node's conflict is unresolved and includes this file, and the method text below with its line breaks kept (`whitespace-pre-wrap`).
- Body, practice session, status `assigned`: the same blocks from `material.propositionMethods` of this file, titled from `lessonNodes` (match `lessonId` and `nodeId`). Several propositions with the same lesson and node and the same method text show as one block. A method whose title is not in `lessonNodes` gets the title `From the lesson`.
- Body, `assigned` with no blocks: `Not used for any plan node.`
- Body, any other status: `No plan nodes yet.` (after the status line).
- The body scrolls inside the dialog (max height about 70 % of the window); Esc, a click outside and a `Close` button close it.
- The dialog reads the data the panel already has (no extra fetch). When a `course-material-changed` refresh arrives while it is open, it shows the new data for the same path; if the path is gone it closes.

**Tests** (`tests/course-file-details-dialog.test.tsx`, plus the updates named above):
- A row renders no node titles; it renders the ⓘ button with the aria-label above; the name button still opens / copies.
- ⚠ appears in the row exactly when an unresolved conflict of one of the file's nodes includes the file; not for a resolved one (`chosen` set), not for a conflict that does not list the file.
- The dialog for an assigned teaching file lists its nodes in plan-map order with pages and method text, `Used for 2 plan nodes:`, and ⚠ on the conflicted node.
- Singular `Used for 1 plan node:`; `Not used for any plan node.` for an assigned file with no methods.
- A waiting file's dialog shows its path, `Status: waiting` and `No plan nodes yet.`; a failed one shows its error.
- A practice file's dialog titles its blocks from `lessonNodes`, merges identical lesson+node+method blocks, and falls back to `From the lesson`.

**Docs.** `docs/architecture.md`, the course files paragraph from plan 007: one sentence that the sidebar rows show name, status and conflict mark, and the ⓘ dialog shows each node's pages and method.

## Last stage

`npm run desktop:dist`, then replace `/Applications/LearnHarness.app` (ask the owner to quit the app first).

## Status per part

| Part | Status |
|---|---|
| 1 Route: practice node titles | green, build-review/20261123-225449-009-part-1 |
| 2 Rows and details dialog | green, build-review/20261123-230852-009-part-2 |
