# 014 — Remove a course file from the list

Status: **approved** 2026-11-24. Runs after plan 013 (it extends 013's details dialog).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–2 through the ladder (`execute-plan` skill) as one queue. The docs are part of Part 2; build and install follow the queue (not a ladder part).
3. After each part is green, update "Status per part" below.
4. Rules for every part: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests a part names as updated. Texts marked **confirmed** are used verbatim.

## What this builds

The Files panel can untick a course file but not remove it. The learner wants to remove files from a session's list. Removing only affects the list; the file on disk is never touched.

## Owner decisions (2026-11-24)

1. A removed file joins again only if a **later** message uses it (the learner names it, the tutor reads it). Old mentions in the transcript never bring it back; nothing remembers removed paths.
2. Remove lives in the file's details dialog: a `Remove from list` button, then an inline confirmation. Rows in the panel are unchanged.

## Spec-level choices (approved with this plan)

- Removing deletes everything stored from that file in the session: the file entry, its course methods, its paths in route conflicts (a conflict left with fewer than two paths is dropped; a `chosen` pointing at it is cleared), its exam patterns, its reference index and pointers, and in a practice session its `propositionMethods` and `propositionExamPatterns`.
- Any status can be removed, including `pending` and `assigning`. A waiting job for the path is skipped when its turn comes; a running one is aborted, and its result or failure is never written back (the file must not reappear, no methods or patterns may be stored for it).
- The tutor's notes follow on their own: the next turn's `[Course material]` / `[Reference]` / `[Course method]` notes no longer list the file (digest rule as today).

## Part 1 — API and queue

**Files.** `app/api/chats/[id]/course/route.ts` (new `DELETE` + doc comment), new pure `src/core/course-remove.ts` (`removeCourseFile(material, path): CourseMaterial`), `src/server/course-assign-queue.ts` (new `cancel(chatId, path)`; skip and discard rules), `src/server/chat-handler.ts` (export a `cancelCourseFile` wrapper like `assignAddedCourseFiles`), `src/core/index.ts`. New tests: `tests/course-remove.test.ts`, `tests/course-remove-route.test.ts`, `tests/course-remove-queue.test.ts`.

- `DELETE /api/chats/:id/course` with body `{ path: string }`: 400 for a malformed body (`Expected { path: string }`), 404 for an unknown chat or path; else `removeCourseFile`, save, `cancel(chatId, path)`, emit `course-material-changed`, 200 `{ ok: true }`.
- `removeCourseFile` applies the cleanup listed above and changes nothing else.
- Queue: a job whose path is no longer in the material's files is skipped (no status write, no worker call). `cancel` aborts the running job for that chat and path. After the worker returns or throws, the queue writes nothing (no status, no `applyAssignment`) when the path is no longer listed; the job store entry ends as `error` with `Removed from the list.` so the activity dock clears.

**Tests.** Cleanup of each stored kind (incl. conflict drop at < 2 paths and `chosen` cleared, practice snapshots); unrelated files untouched; route 400/404/200 and event; a queued job for a removed path never calls the worker; a running job is aborted and its success result is not applied (no methods stored, file not re-added); a later turn that uses the path adds it again as a new `pending` file.

## Part 2 — UI: remove from the details dialog

**Files.** `components/course-file-details-dialog.tsx`, `components/session-course-files.tsx`, `docs/architecture.md` (course files section: removing a file — what is deleted, re-joining on later use, queue cancel). New test: `tests/course-remove-dialog.test.tsx`.

- In the dialog's button row, before the move buttons: `Remove from list` (**confirmed**), muted destructive style.
- Click replaces the row with the confirmation (**confirmed**): `Remove <file name>? What was read from it is removed too. The file itself stays on your disk.` and buttons `Remove` / `Cancel`.
- `Remove` sends the DELETE, closes the dialog on success; the panel refetches on `course-material-changed`. On failure the confirmation stays and shows `Could not remove the file. Try again.` (**confirmed**). `Cancel` restores the button row.
- When the last file is removed, the "Files (n)" row hides (existing rule).
- The dialog's per-file states (the open confirmation, the remove failure text, and plan 013's `Could not retry. Try again.` flag) reset whenever the dialog shows a different file, so none carries over from one file to the next.

**Tests.** Button present for every status; confirm text with the file name; Remove sends `DELETE` with `{ path }` and closes; Cancel restores; failure text; switching the dialog to another file clears the confirmation, the remove failure and the retry failure.

## Last stage — build and install (after the queue, not a ladder part)

`npm run desktop:dist`, ask the owner to quit the app, replace `/Applications/LearnHarness.app`.

## Status per part

| Part | Status |
|---|---|
| 1 API and queue | green, build-review/20261124-122016-014-part-1 |
| 2 UI remove from dialog | green, build-review/20261124-125714-014-part-2 |
| Build and install | installed 2026-11-24 |
