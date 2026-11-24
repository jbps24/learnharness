# 013 — Retry a failed course file; "1 section"

Status: **approved** 2026-11-24.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–2 through the ladder (`execute-plan` skill) as one queue; Part 3 alone with `--no-tests-first`.
3. After each part is green, update "Status per part" below.
4. Rules for every part: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests a part names as updated. Texts marked **confirmed** are used verbatim.

## What this builds

When reading a course file stops (e.g. the learner stopped it by accident: "Assignment was interrupted."), the file stays `failed` and there is no way back. Plan 007 left out a re-assign button; a retry for **failed** files is now wanted. Plan 012's dialog also says "1 sections".

## Owner decisions (2026-11-24)

1. Clicking a `failed` status chip in the Files panel opens a small popover under it: the error text and a **Retry** button. Retry sets the file back to `pending` ("waiting") and queues it again.
2. Failed files only. The details dialog of a failed file also gets a **Retry** button. Assigned files cannot be re-read (no "Read again").
3. The table-of-contents line says "1 section" for one section.

## Spec-level choices (approved with this plan)

- Retry keeps the file's `category`, `categoryBy`, `binding` and whatever it already stored (methods, exam patterns, reference index/pointers); the next successful read replaces them for its targets as today.
- Retry targets all plan nodes, like a newly added file (`assignAddedCourseFiles(chatId, [path])`, `src/server/chat-handler.ts`). With no plan yet, the file stays `pending` and is read at the first `plan_init` (as today).
- An unticked file can't be retried (the queue skips unticked files): the popover and dialog show the Retry button disabled with the tooltip below, and the API answers 409.

## Part 1 — API: `{ path, retry: true }`

**Files.** `app/api/chats/[id]/course/route.ts` (PATCH and its doc comment). New test: `tests/course-retry-route.test.ts`.

PATCH accepts a third body shape `{ path: string, retry: true }`:
- Exactly one of `binding`, `category`, `retry` per body, else 400; `retry` must be `true`, else 400. The 400 message becomes: `Expected { path: string, binding: boolean }, { path: string, category: "material" | "exam" | "reference" } or { path: string, retry: true }`.
- Unknown chat or path: 404 (as today).
- File status not `failed`: 409 `{ "error": "Only a failed course file can be retried." }`.
- File unticked: 409 `{ "error": "Tick the file to read it again." }`.
- Otherwise: status `pending`, `error` removed, nothing else changed; save, emit `course-material-changed`, `assignAddedCourseFiles(id, [path])`; 200 `{ ok: true }`.

**Tests.** Retry of a failed ticked file (status, error gone, other fields and stored data unchanged, event emitted, queued); 409 for each non-failed status and for an unticked file; 400 for `retry: false` and for two keys; 404 unknown path.

## Part 2 — UI: the popover, the dialog button, "1 section"

**Files.** `components/session-course-files.tsx`, `components/course-file-details-dialog.tsx`. New test: `tests/course-retry-panel.test.tsx`. Updated test: `tests/reference-files-panel.test.tsx` (the `1 sections` assertion becomes `1 section`).

- **Chip.** A `failed` chip becomes a button (`aria-haspopup="dialog"`, same look plus a hover underline); other statuses stay plain text. Click opens a popover (`Popover` from `radix-ui`, already a dependency) under the chip with the error (`file.error`, or **confirmed** `Reading failed.` when absent) and a button **confirmed** `Retry`. Esc or a click outside closes it.
- **Retry click** sends the Part 1 PATCH and closes the popover; the chip turns "waiting" from the `course-material-changed` refetch. On a failed request the popover stays open and shows **confirmed** `Could not retry. Try again.`
- **Unticked file:** `Retry` disabled with tooltip **confirmed** `Tick the file to read it again.`
- **Dialog.** For a `failed` file, a `Retry` button before the move buttons, same request and rules.
- **Pluralisation.** `Table of contents: 1 section (from …)`, `N sections` otherwise.

**Tests.** Only a failed chip is a button; the popover shows the error / fallback text; Retry sends `{ path, retry: true }`; failure text; disabled when unticked; dialog Retry for failed only; "1 section" and "2 sections".

## Part 3 — Docs, build, install (`--no-tests-first`)

- `docs/architecture.md`, course files section: retry of a failed file (PATCH `retry`), failed files only.
- Last stage: `npm run desktop:dist`, ask the owner to quit the app, replace `/Applications/LearnHarness.app`.

## Verification

In the installed app, Speech Signal Processing lesson: the failed file's chip opens the popover with "Assignment was interrupted." → Retry → "waiting" → "reading…" → "assigned". A Reference book's dialog reads "Table of contents: 388 sections (from outline)".

## Status per part

| Part | Status |
|---|---|
| 1 API retry | |
| 2 UI popover, dialog, "1 section" | |
| 3 Docs, build, install | |
