# 015 — Replace a course file with a newer version

Status: **approved** 2026-11-24. Runs after plan 014 (it extends the details dialog of plans 009/013/014).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–4 through the ladder (`execute-plan` skill) as one queue. Docs are part of Part 4; build and install follow the queue (not a ladder part).
3. After each part is green, update "Status per part" below.
4. Rules for every part: tests first and locked; new test files and helpers only; existing tests keep passing unchanged, except the tests a part names as updated. Texts marked **confirmed** are used verbatim.

## What this builds

The Regelungssysteme course published a new script. Today the learner can only untick the old one and name the new one: the new file is read from scratch, nobody learns what changed, and an old file overwritten under the same name is never noticed. This plan adds a **replacement**: the new version takes the old one's place, the reader compares the two per plan node, the learner sees the changes, and the tutor revisits changed routes and proposes plan changes.

## Owner decisions (2026-11-24)

1. **Trigger:** a `Replace with newer version…` button in the file's details opens the file picker; and a listed file that changed on disk under the same name is marked `changed` in the panel, offering the same update.
2. **Tutor:** the binding route switches to the new version at once. For plan nodes already taught whose route changed, the tutor gets a `[Course update]` note and briefly points out the change (old vs new route) when the learner next works on that node or at the next natural pause. Untaught nodes simply use the new route.
3. **Plan:** the reader lists plan nodes the new version no longer covers and sections of the new version that no plan node covers. The tutor asks the learner with a question whether to add or drop plan nodes, and rewrites the plan only for what the learner accepts.
4. **New topics:** sections of the new version outside the plan (at most 15, teachable content only), from one read of the new file. Some may be topics the plan skipped on purpose; the learner decides.

## Spec-level choices (approved with this plan)

- **The comparison needs no old file.** The old version is represented by its stored course methods per node, snapshotted when the replacement starts. So an overwritten file and a differently named one work the same way, and the cost is one read of the new file (as when adding a file).
- **Change kinds per plan node:** `same` (same route; pages may differ), `changed` (different route), `new` (the new version covers a node the old one didn't), `dropped` (the old version covered it, the new one doesn't).
- **What carries over:** `binding`, `category`, `categoryBy`, and a resolved route conflict's `chosen` (moved to the new path). The old path leaves the list (its methods, conflict entries, exam patterns and reference data are replaced by the new read). `via` becomes `"learner"`.
- **Categories:** replacement works for every category. Only **course material** gets the comparison, the change list and the `[Course update]` note; an exam's patterns and a reference's index and pointers are simply rebuilt.
- **Practice:** existing practice snapshots are not refreshed (plan 007 choice 7).
- **Change detection:** when a read starts, the file's fingerprint `{ size, mtimeMs, sha256 }` is stored. On every Files GET and before each teaching turn's notes, listed files are `stat`ed; only when size or mtime differ is the hash recomputed, and a different hash sets `changedOnDisk: true` (saved, event emitted). Files read before this plan get their fingerprint at the first check, without being flagged. A missing file is not flagged.
- **Desktop only:** the picker uses the existing `window.lh.getPathForFile` bridge with a hidden file input; in the plain browser the Replace button is not shown. The `changed` → Update flow works in both.
- **"Already taught"** means the node has at least one tagged `quiz`/`explain` call before the replacement time (`teachTags`, `src/core/units.ts`).

## Part 1 — Contracts and the pure comparison

**Files.** `src/core/contracts/course.ts`, new `src/core/course-replace.ts`, `src/core/index.ts`. New tests: `tests/course-replace-contracts.test.ts`, `tests/course-replace-apply.test.ts`.

- `CourseFile` gains `fingerprint?: { size: number; mtimeMs: number; sha256: string }`, `changedOnDisk?: boolean`, `update?: CourseUpdate`.
- `CourseUpdate { at: string; fromPath: string; previous: Array<{ nodeId: string; pages?: string; method: string }>; nodes?: Array<{ nodeId: string; kind: "same" | "changed" | "new" | "dropped" }>; newSections?: Array<{ title: string; pages: string }>; revisited: string[]; planAsked: boolean }` — `nodes`/`newSections` are absent until the read finishes. `NEW_SECTIONS_CAP = 15`.
- `startReplacement(material, oldPath, newPath, now): CourseMaterial` — snapshots the old file's binding methods into `previous`; replaces the file entry (new path, carried-over fields, status `pending`, no `error`, no `changedOnDisk`, no `fingerprint`); removes the old path's methods, exam patterns, reference index and pointers; in conflicts swaps the old path for the new one (keeping `chosen` when it was the old path). `update` is set only for category `material`.
- `classifyUpdate(previous, newMethods, sameAsPrevious: Record<nodeId, boolean>): CourseUpdate["nodes"]` — the four kinds above, in plan-map order.

**Tests.** Snapshot and carry-over (each field), conflict path swap with `chosen`, exam/reference files get no `update`; classification of all four kinds; a record without the new fields round-trips unchanged.

## Part 2 — Server: replace route, fingerprints, change detection, the reader

**Files.** New route `app/api/chats/[id]/course/replace/route.ts`, `src/server/course-assign-queue.ts`, new `src/server/course-fingerprint.ts`, `app/api/chats/[id]/course/route.ts` (GET runs the check), `src/server/chat-handler.ts` (check before teaching notes), `src/core/course-assign.ts` + `src/agent/subagents/course-assign.ts` (replace mode). Updated test: `tests/course-assign-parse.test.ts` (replace-mode fields). New tests: `tests/course-replace-route.test.ts`, `tests/course-fingerprint.test.ts`, `tests/course-replace-assign.test.ts`.

- `POST /api/chats/:id/course/replace` body `{ path: string; newPath: string }`:
  - 400 malformed (`Expected { path: string, newPath: string }`); 404 unknown chat or path;
  - `newPath` resolved like `resolveSourcePath`; 400 `Not a readable course file: <newPath>` when it is missing, a directory, or not assignable;
  - 409 `<file name> is already in the list.` when `newPath` ≠ `path` and is listed;
  - otherwise `startReplacement`, save, abort a running job for `path` (plan 014's `cancel`), emit, queue the new path in replace mode against all plan nodes; 200 `{ ok: true }`.
- **Fingerprint** stored at job start; detection as in the spec choices; `changedOnDisk` cleared when a new read starts.
- **Reader, replace mode** (material only). The task lists, per node, the previous version's method; the instructions gain this paragraph (**confirmed**):

> This file replaces an earlier version of the same course file. For each node, the task shows the earlier version's method. For every node this file works through, also set "sameAsPreviousVersion": true when the route is the same (same steps, possibly other wording, notation or pages), false when it changed, null when the earlier version had no method for the node. Then list in "newSections" the sections of this file that teach substantive content and that no plan node covers, at most 15, each as {"title":string,"pages":string}.

- `parseAssignment` accepts `sameAsPreviousVersion` (boolean | null) and `newSections` (≤ 15, title and pages non-empty) in replace mode only; problems as today.
- On success: `applyAssignment` as today for the methods, then `classifyUpdate` fills `update.nodes` and `update.newSections`.

**Tests.** Route errors and success (snapshot taken, old path gone, job queued in replace mode, running job aborted); same-path update; fingerprint baseline without flag, flag on content change, no flag on mtime-only change with the same hash, missing file not flagged; replace-mode parse problems; apply fills the update.

## Part 3 — The tutor: `[Course update]` note, `course_update` tool, prompt

**Files.** `src/core/course-notes.ts`, `src/core/native-messages.ts` (customType `course-update`, neutral, `display:false`, same skip lists as `course-method`), `src/server/chat-handler.ts` (teaching turns), new tool `src/agent/tools/course-update.ts` (teacher only), `src/agent/prompts/shared/30-learner-files.md`. New tests: `tests/course-update-note.test.ts`, `tests/course-update-tool.test.ts`, `tests/course-update-prompt.test.ts`.

- **Note** due (digest rule) while a material file's `update` has open items: changed nodes already taught and not in `revisited`, or (`dropped` nodes or `newSections`) with `planAsked` false. Not limited to the current unit. Text (**confirmed**):

> [Course update] <old file name> was replaced by a newer version, <new file name>. The [Course method] notes now show the new routes.
> Changed routes in steps already taught. When the learner next works on one of these, or at the next natural pause, point out briefly what changed (earlier route vs the new one) and check the new route once, then call course_update with the node id:
> - `<nodeId>` (<title>), earlier route: <previous method> (<pages>)
>
> Steps the new version no longer covers: `<nodeId>` (<title>), …
> Sections of the new version no plan step covers: <title> (<pages>); …
> Ask the learner with ask_user_question which of these to add as plan steps and which uncovered steps to drop. Rewrite the plan only for what they accept, then call course_update with "plan".

  Lines for an empty group are left out.
- **Tool** `course_update({ path: string, item: string })` — `item` is a node id from the changed-and-taught list (added to `revisited`) or `"plan"` (sets `planAsked`). Description (**confirmed**): `Records that you handled one item of a [Course update] note: a changed route you pointed out (the node id) or the plan question you asked (\"plan\"). Handled items leave the note.` Result: `Recorded.` Errors (**confirmed**): `No course update for <path>.`, `Not an open item of this course update: <item>`.
- **Prompt** (shared, after the Reference paragraph; **confirmed**): `A [Course update] note means the learner's course published a newer version of a file. Follow the new routes from now on. Treat its items as part of the teaching, not as an interruption: point out a changed route where it fits the conversation, and ask the plan question at a natural pause.`

**Tests.** Note due/not due for each open-item case; taught vs untaught (tags before the replacement time); empty groups omitted; digest stops repeats and changes after the tool; tool errors and effects; the prompt fragment in the teacher prompt.

## Part 4 — UI and docs

**Files.** `components/course-file-details-dialog.tsx`, `components/session-course-files.tsx`, `docs/architecture.md`, `CONTEXT.md`. New tests: `tests/course-replace-dialog.test.tsx`, `tests/course-changed-chip.test.tsx`.

- **Dialog button** `Replace with newer version…` (desktop only), opening a file input (`accept=".pdf,.md,.markdown,.txt,.tex"`); the chosen path goes to the replace route. Errors from the route are shown under the button.
- **Changed chip:** a file with `changedOnDisk` shows a `changed` chip (button) instead of its status; its popover says `This file changed on disk since it was read.` with a button `Update`, which sends `{ path, newPath: path }`.
- **Change list** in the dialog of a replaced material file: `Replaced <old file name> on <date>.` then the groups `Changed route`, `Newly covered`, `No longer covered`, `Sections outside the plan`, each with node titles (or section title and pages); a changed node in `revisited` gets `pointed out`. While the read runs: `Comparing with the earlier version…`. (All texts in this bullet **confirmed**.)
- **Docs:** `docs/architecture.md` course files section (replacement, comparison, fingerprints, the note and tool); `CONTEXT.md` glossary: **Course update** (a replaced course file's changes per plan node, kept until the tutor has handled them), **Replacement** (a newer version of a course file taking the old one's place in the list).

**Tests.** Button absent without the bridge; picked path posted; route errors shown; `changed` chip and Update body; change list groups, `pointed out`, the running text.

## Last stage — build and install (after the queue, not a ladder part)

`npm run desktop:dist`, ask the owner to quit the app, replace `/Applications/LearnHarness.app`.

## Verification

Regelungssysteme lesson in the installed app: open the old script's details → Replace with newer version… → pick the new script. The list shows the new file reading, then `assigned` with its change list. On the next turn the request carries a `[Course update]` note listing changed taught nodes, uncovered nodes and outside sections; the tutor asks the plan question; `course_update` calls shrink the note. Overwriting a listed file on disk shows `changed`; Update runs the same flow.

## Status per part

| Part | Status |
|---|---|
| 1 Contracts and comparison | green, build-review/20261124-131813-015-part-1 |
| 2 Server, fingerprints, reader | green, build-review/20261124-133720-015-part-2 |
| 3 Tutor note, tool, prompt | green, build-review/20261124-143312-015-part-3 |
| 4 UI and docs | green, build-review/20261124-150500-015-part-4 |
| Build and install | |
