# 007 — Course methods: course files bound to plan nodes

Status: **approved** 2026-11-22. The owner confirmed the product decisions, every spec-level choice and every agent-facing and UI text (the worker instructions with two changes, see Part 3).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts through the ladder (`execute-plan` skill), e.g. `ladder queue --plan plans/007-course-methods.md --step "Part 1" …`. Part 8 takes `--no-tests-first`.
3. This plan runs on `feat/antigravity-cli` **before** plans 005 and 006, on a clean tree. Plan 003 is committed and merged (2449ce86, 9f00687c).
4. After each green part, update "Status per part" at the end of this file. Never re-open the owner decisions.

## What this builds

In the Regelungssysteme lesson, the tutor taught a route the course never used. Two causes:

- The planning prompt tells it to "Scope the field from your own knowledge" (`src/agent/prompts/teacher/10-planning.md`), and no prompt makes the learner's course material binding.
- When the learner pointed it at `mitschrift_1.pdf` and `mitschrift_2.pdf`, it promised to follow them. That promise lived only in the transcript: the PDF briefs are `subagent-steer` messages, and the next unit cut replaces them with a lesson record that keeps none of their content.

This plan makes the course's route durable and node-scoped:

- Every session keeps a list of its **course files**, filled automatically from the files used. The learner can switch each file off.
- A background **assignment worker** reads each course file against the plan map. For each plan node the file works through, it stores the **course method**: steps, notation and pages. The methods live on the chat record, outside the transcript, so unit cuts and compaction cannot lose them.
- While a node's unit is current, the tutor's context carries a **course-method note** for that node, re-sent whenever a cut or compaction drops it. The note makes the route binding.
- When two files give different routes for one node (a **route conflict**), the tutor asks the learner and stores the choice.
- Practice sessions inherit the methods of the lesson nodes their picked propositions came from.
- Under the open session, the sidebar shows a **Files** dropdown: per file a binding tick, its status, the nodes it supplied, conflict marks, and click to open.

Vocabulary, added to repo-root `CONTEXT.md` in Part 8: **course file**, **course method**, **route conflict**, **course-method note**.

## Owner decisions (2026-11-22; do not re-open)

1. **Which files.** Every local file the learner attaches or names, and every local file the tutor reads, joins the session automatically as a course file. The learner can untick a file in the sidebar so its methods stop binding.
2. **Strictness.** The tutor teaches, checks and grades by the course route and notation for that node. It gives another route only if the learner asks, and then labels it explicitly as not from their course.
3. **Conflicts.** When two course files describe different routes for one node, the tutor asks the learner which route their course uses, and the answer is stored on the node.
4. **Dropdown.** Per file: name (click opens it), the binding tick, an assignment status, and the plan nodes it supplied a method for. Unresolved conflicts are marked.
5. **Existing lessons.** Backfilled automatically. On its next turn, an existing teaching lesson collects the files already used in its transcript and runs assignment in the background.
6. **Practice.** Included in this plan. Practice sessions inherit course methods from the lessons their picked propositions came from.

Out of scope:
- assigning images (choice 3);
- a "re-assign" button;
- editing a stored method by hand;
- showing methods in the plan map popup;
- the knowledge-graph "notes" import (Sources), which stays as it is.

## Rules for every part

- Tests are new files under `tests/` (flat, `*.test.ts` / `*.test.tsx`, run by `npm test`). **Do not reuse or edit existing test fixtures or helpers**; write new helpers inside the new test files. Existing tests must keep passing unchanged, except where a part names a test it updates.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`.
- Pure logic lives in `src/core/` (no server imports), server wiring in `src/server/` and `app/api/`, and agent tools and workers in `src/agent/`.
- Every agent-facing text and error message is exact text from this plan, once the owner has confirmed it.
- Line numbers were read on `feat/antigravity-cli` @ 4a1d2e03; re-locate by symbol name if they moved.

## Spec-level choices (confirmed by the owner 2026-11-22)

1. **Delivery channel.** Methods reach the tutor as wire-only markers appended to learner inputs, the pattern of `breakNotesFor` (plan 002) and `units-note` (plan 001). They do not go into the system prompt, which would invalidate the prompt cache on every node change.
2. **Granularity.** A course-method note is due for every node of the **current unit** (the whole plan when it has no units), not only the current node. A node becomes current only at its first tagged `quiz`/`explain` call, and that call is the predict question, so a note sent only for the current node would arrive after the tutor had already framed the node. A unit is only left through a unit cut, so "while we are in that node" holds.
3. **Assignable file types.** PDF (`.pdf`) and text (`.md .markdown .txt .tex`). Every other type is listed with status `not-assignable`.
4. **Local files only.** Directories, URLs and the researcher's downloaded web PDFs never join. Paths are resolved the way `resolveSourcePath` (`src/agent/tools/fs-shared.ts`) does.
5. **Plan rewrites.** A `plan_init` rewrite re-assigns only node ids that are new or whose title or summary changed. Methods and conflicts of removed nodes are dropped.
6. **Untick / re-tick.** Unticking keeps the stored methods but excludes them from notes, conflicts and practice snapshots. Re-ticking restores them without re-running the worker.
7. **Practice snapshot.** Taken once, when the practice session is created. Later changes to the lesson's methods do not reach an existing practice session.
8. **Practice grading.** A correct learner solution by another route is graded correct. The verdict names the route the course uses.
9. **Size cap.** Each stored method has at most 1,500 characters per node per file.
10. **Worker model.** The assignment worker uses the PDF worker's model slot and its override (`pdfModelOverride`, `src/agent/subagents/runner.ts:66`).
11. **Activity dock.** A running assignment shows in the activity dock as one background job per file: "Assigning <file name> to the plan".
12. **Opening a file.** Click opens the file through a new desktop bridge that only opens paths listed as course files of that session. In the plain browser, click copies the path.

---

## Part 1 — Course files: contract and collection (pure core)

**Goal.** A contract for course material on the chat record, and a pure function that finds the course files a transcript used.

**Files.**
- New `src/core/contracts/course.ts`, exported through `src/core/contracts.ts` / `src/core/index.ts`.
- `src/core/contracts/chat.ts`: `ChatRecord` (~l.24) gains `courseMaterial?: CourseMaterial`.
- New `src/core/course-files.ts`.
- New tests: `tests/course-files.test.ts`.

**Contract.**

```ts
// src/core/contracts/course.ts
export type CourseFileStatus = "pending" | "assigning" | "assigned" | "failed" | "not-assignable";
export interface CourseFile {
  path: string;            // absolute, home-resolved; the identity
  addedAt: string;         // ISO
  via: "learner" | "tutor" | "inherited";
  binding: boolean;        // the learner's tick; true when added
  status: CourseFileStatus;
  error?: string;          // only when status is "failed"
}
export interface NodeMethod {
  nodeId: string;
  path: string;            // the course file it came from
  pages?: string;          // e.g. "S. 20–27"
  method: string;          // ≤ COURSE_METHOD_CAP chars
}
export interface NodeConflict {
  nodeId: string;
  paths: string[];         // ≥ 2 course files with different routes, in the order found
  chosen?: string;         // set by course_route; one of paths
}
export interface PropositionMethod {
  propositionId: string;
  lessonId: string;
  nodeId: string;
  path: string;
  pages?: string;
  method: string;
}
export interface CourseMaterial {
  files: CourseFile[];
  methods: NodeMethod[];
  conflicts: NodeConflict[];
  /** Practice sessions only: the snapshot taken at creation (Part 6). */
  propositionMethods?: PropositionMethod[];
}
export const COURSE_METHOD_CAP = 1_500;
export const ASSIGNABLE_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt", ".tex"] as const;
```

An absent `courseMaterial` means "never collected". Part 2's backfill keys on that.

**Functions** (`src/core/course-files.ts`):

- `courseFilesUsed(messages: readonly LhMessage[]): { path: string; via: "learner" | "tutor" }[]` returns the distinct paths in transcript order (first occurrence wins `via`):
  - **learner:** `parseFilePaths` (`src/core/file-paths.ts:35`) over learner text messages, `practice-thinking` contents, and the `text` and `readingThinking` of answered `quiz`/`explain` results. Parts for which `isDirectoryReference` is true are skipped.
  - **tutor:** the `path` input of `read` tool calls, of `pdf` job calls (`src/agent/tools/jobs.ts:194`), and the visual job's `pdf.path` input (`jobs.ts:69`).
  - Never: URLs, paths that are not absolute after `~` expansion, side-chat messages.
- `mergeCourseFiles(existing: CourseMaterial | undefined, found, now: string): { material: CourseMaterial; added: string[] }`:
  - adds each unknown path with `binding: true` and with status `pending`, or `not-assignable` when its extension (lower-cased) is not in `ASSIGNABLE_EXTENSIONS`;
  - never removes a file and never changes an existing file's `binding`, `status` or `via`;
  - returns the new paths in `added`.
- `isAssignable(path: string): boolean`.

**Tests** (`tests/course-files.test.ts`):
- a learner message with two chipped paths and a directory reference gives the two files with `via: "learner"`;
- a `read` call and a `pdf` call give `via: "tutor"`, and a path seen first from the learner stays `learner`;
- a path in an answered explain's `readingThinking` is found (this is the Regelungssysteme case);
- URLs and relative paths are ignored;
- merge keeps an unticked file unticked and a `failed` status unchanged;
- a `.png` gets `not-assignable` and a `.PDF` is assignable.

---

## Part 2 — Persistence, backfill, API and event

**Goal.** Course files are kept on the record after every turn, existing lessons are backfilled, and the UI can read the material and change ticks.

**Files.**
- `src/store/` chat store (the `ChatStore` that owns `saveMessages`): `getCourseMaterial(chatId)` and `setCourseMaterial(chatId, material)`, written atomically like the other record fields.
- `src/core/events.ts`: new event `course-material-changed` with payload `{ chatId: string }`.
- `src/server/chat-handler.ts`: after a turn's messages are persisted, run `courseFilesUsed` over the new messages. On the first turn of a session whose record has no `courseMaterial`, run it over the whole transcript (backfill). Merge the result, save it, and emit `course-material-changed` when anything changed. Hand `added` to the Part 3 queue.
- New route `app/api/chats/[id]/course/route.ts`:
  - `GET` returns `{ material: CourseMaterial | null, nodes: { id: string; title: string }[] }`, with node titles taken from `record.tree`;
  - `PATCH` takes body `{ path: string; binding: boolean }` and sets that file's tick. Status 404 when the chat or path is unknown, 400 for a malformed body. It emits `course-material-changed`.
- New tests: `tests/course-material-store.test.ts`, `tests/course-route.test.ts`, `tests/course-backfill.test.ts`.

**Rules.**
- Collection runs for teach and practice sessions alike. For practice, Part 6 adds the inherited files.
- Collection never blocks the turn's response. A failure is logged and retried on the next turn.
- PATCH only changes `binding`. Re-ticking never sets status back to `pending` (choice 6).

**Tests.**
- Backfill of a record with an answered explain naming two PDFs yields two `pending` files.
- A second turn with no new paths does not emit the event.
- PATCH false, then a GET, shows `binding: false`.
- PATCH with an unknown path returns 404.

---

## Part 3 — The assignment worker

**Goal.** A background worker reads one course file against the plan's nodes. It stores a method for each node the file works through and records route conflicts.

**Files.**
- New `src/agent/subagents/course-assign.ts`, which reuses `createPdfTools` / the `runPdfReaderAgent` loop from `src/agent/subagents/pdf-reader.ts` for PDFs. Text files are read whole (capped like `read`, 2000 lines / 50 KB per chunk, with the worker paging through).
- New `src/core/course-assign.ts` (pure): the prompt builder, `parseAssignment`, `applyAssignment` and `assignmentTargets`.
- `src/server/` new `course-assign-queue.ts`: one serial queue per chat. It is fed by Part 2 (new files), by `plan_init` (rewrites) and by backfill.
- `src/agent/tools/plan.ts`: after a successful `plan_init`, enqueue the changed nodes (rule 2).
- New tests: `tests/course-assign-parse.test.ts`, `tests/course-assign-targets.test.ts`, `tests/course-assign-queue.test.ts` (worker stubbed).

**Worker input.**
- the file path;
- the target nodes: `{ id, title, summary?, unitTitle?, unitSource? }[]`;
- for each target node, the methods other binding files already gave it: `{ path, method }[]`.

**Worker output.** One JSON object:

```json
{"nodes": [{"nodeId": "fkl-step1", "pages": "S. 20–27", "method": "…", "sameRouteAsExisting": true}]}
```

- Only nodes the file actually works through. A node the file doesn't cover is left out.
- `sameRouteAsExisting` is `null` when the node had no existing methods.

**`parseAssignment(text, targetIds)`** collects problems, like `parseLessonRecordJudgment` does:
- unknown or duplicate node ids;
- an empty `method`, or one over `COURSE_METHOD_CAP`;
- `sameRouteAsExisting` that is not boolean or null.

On problems the worker gets one repair attempt with the problems listed. A second failure gives status `failed`, and `error` is the joined problems.

**`applyAssignment(material, path, result)`:**
- replaces this file's methods for the target nodes;
- `sameRouteAsExisting: false` adds this path to that node's `NodeConflict`, creating it with the existing path(s) first;
- `true` leaves conflicts alone;
- sets the file's status to `assigned`.

**Triggers** (`assignmentTargets`):
1. A file in `added` that is assignable and binding, and a tree exists → all nodes.
2. `plan_init` success → the node ids that are new, or whose title or summary changed, against the previous tree, for every assigned binding file. Methods and conflicts of node ids no longer in the tree are dropped right away (choice 5). A conflict left with fewer than two paths is dropped.
3. A file that was added while no tree existed stays `pending` and is picked up by trigger 2 at the first `plan_init`.

**Status.**
- Status moves to `assigning` when the job starts.
- Every status change saves and emits `course-material-changed`.
- The job is registered in the job store so the activity dock shows it (choice 11).
- An aborted or crashed job leaves status `failed` with `error: "Assignment was interrupted."`

**Worker instructions** (confirmed) (system prompt, appended after the pdf-reader's reading doctrine, which stays verbatim):

> You read one course file for a learning application. The learner must pass an exam in this course, so the course's own way of solving each problem is what matters, not the most standard or shortest way.
>
> You get the lesson's plan nodes (id, title, summary). For every node this file actually works through, write down the course's route: the procedure step by step, the notation and conventions it uses, the criteria or tables it applies, in the order the file does it. Write it so a tutor can teach and grade by it without the file. Write the method in the file's language. Cite pages the way the file numbers them, e.g. (S. 12) or (p. 12). Leave out nodes the file only mentions or doesn't cover. Never fill a gap from your own knowledge.
>
> Some nodes already carry a method from another course file. For those, also decide: does this file use the same route (same steps, possibly other wording or notation) or a different route? Set sameRouteAsExisting to true or false.
>
> Return ONE JSON object and nothing else: {"nodes":[{"nodeId":string,"pages":string,"method":string,"sameRouteAsExisting":boolean|null}]}. Each method at most 1,500 characters.

**Tests.**
- A valid result for two of three targets stores two methods and status `assigned`.
- An unknown node id or an over-cap method is a problem.
- `false` creates a conflict with both paths in order.
- A rewrite that renames one node's title targets only that node.
- A removed node's methods and conflict disappear.
- A file added before any tree is assigned at the first `plan_init`.

---

## Part 4 — Notes to the tutor and the `course_route` tool

**Goal.** The tutor always has the binding route of the current unit's nodes in its context, and can record the learner's choice in a conflict.

**Files.**
- `src/core/native-messages.ts`:
  - `customType` gains `"course-files" | "course-method"`;
  - constructors `newCourseFilesNoteMessage(paths: string[])` and `newCourseMethodNoteMessage(nodeId: string, text: string, digest: string)`, both `display: false`, with `details` `{ paths }` and `{ nodeId, digest }`;
  - both are classified `"neutral"` (~l.1070) and go on the wire as user text like `units-note`;
  - `src/core/input-events.ts` skip list and `src/server/unit-cut.ts` `withoutMarkers` include both.
- New `src/core/course-notes.ts`: `courseNotesFor(messages, tree, material): LhMarkerMessage[]`.
- `src/server/chat-handler.ts` (~l.614–630): append `courseNotesFor(...)` to `appends` for teaching turns on the same learner input types as the break notes, before the break notes.
- New tool `src/agent/tools/course-route.ts`, registered for the teacher only.
- New tests: `tests/course-notes.test.ts`, `tests/course-route-tool.test.ts`.

**`courseNotesFor` rules.**
- "Live" means at or after `projectionHeads(messages).start` (`src/core/compaction.ts:157`).
- **course-files:** due when the sorted list of binding course files is not empty and differs from the `paths` of the newest live `course-files` note. Also due when there is none and the list is not empty.
- **The nodes in scope** are:
  - the nodes of the current unit, which is the unit of the current node from `derivePlanStatusesLh`;
  - before any tagged call, the first unit;
  - with no units, all nodes.
- **course-method:** for each node in scope that has at least one binding method, build the note text (below) and its `digest` (a stable hash of the text). The note is due when no live `course-method` note carries this `nodeId` with this `digest`.
- Binding methods are the methods of files with `binding: true`. A conflict counts only while at least two of its paths are binding.
- Order: the course-files note first, then nodes in map order.

**`course_route({ nodeId: string, path: string })`:**
- sets `chosen` on that node's conflict and saves it;
- emits `course-material-changed`;
- the result is `"Recorded: node <id> follows <file name>."`.
- The next learner input carries a fresh course-method note, because its digest changed.

**Course-files note** (confirmed):

> [Course material] This lesson's course files (their methods are binding):
> - <path>
> - <path>
>
> Files the learner switched off are not listed and no longer bind.

**Course-method note** (confirmed; one method, or a conflict that has been resolved):

> [Course method] Node `<id>` (<title>): the learner's course works this as follows. Teach, check and grade exactly this route:
> <method> (<file name>, <pages>)

With several binding files on the same route, each method follows under its own `(<file name>, <pages>)` line.

**Conflict note** (confirmed; an unresolved conflict):

> [Course method] Node `<id>` (<title>): the course files describe different routes:
> A — <file name>, <pages>: <method>
> B — <file name>, <pages>: <method>
>
> Before you teach or check this node, ask the learner with ask_user_question which route their course uses (one option per file), then call course_route with the node id and the chosen file's path.

**`course_route` description** (confirmed):

> Records which course file's route the learner's course uses for a node whose course files disagree. Call it only after the learner chose via ask_user_question. Later course-method notes show only that route.

**`course_route` errors** (confirmed):
- `Unknown node id: <id>`
- `Node <id> has no conflicting course methods.`
- `Not one of this node's conflicting course files: <path>`

**Tests.**
- With no material, there are no notes.
- Entering unit 2 makes notes due for unit 2's nodes only.
- A second input with the notes live makes nothing due.
- After a lesson-record cut, the notes are due again.
- Unticking a file changes the course-files note and drops that file's method from the node note.
- An unresolved conflict gives the conflict text, and after `course_route` the single-route text.
- All three tool errors produce their exact text.

---

## Part 5 — Prompt edits

**Goal.** The agents treat course material as binding and plan along it.

**Files.**
- `src/agent/prompts/shared/30-learner-files.md`: append the **Course material** section. It is shared, so it reaches the teacher, prober and practice agents.
- `src/agent/prompts/teacher/10-planning.md`: insert the planning bullet as the first bullet under "Planning — think hard here" (~l.7).
- `src/agent/prompts/practice/00-base.md`: append the practice paragraph after "The side tools." (Part 6 supplies its notes.)
- `src/agent/prompts/teacher/40-jobs.md` "Learner source files": one sentence pointing at the course material section.
- New test: `tests/course-prompts.test.ts`, which checks that each composed agent contains its fragment.

**Course material (shared)** (confirmed):

> ## Course material
>
> Files the learner's course uses, listed in a [Course material] note, define how this learner has to solve problems. Their routes, steps and notation are binding: teach, check, hint and grade by them, never by a shorter or more standard route. A [Course method] note gives a node's binding route. If the learner asks for another route, give it and label it plainly as not from their course. Where the material leaves a step open, fill it from your own knowledge and say so.

**Planning bullet** (confirmed):

> - If the session has course material, the route comes from it, not from you: read the course files before planning (pdf jobs for PDFs) and build the map along the material's own procedures, in its order and with its names. Your own knowledge checks the material and fills what it leaves open; it never replaces the material's route.

**40-jobs sentence** (confirmed):

> Files the learner names become the lesson's course material; read them with that in mind.

**Practice paragraph** (confirmed):

> **Course methods.** When a [Course method] note lists a method for a proposition, model solutions, hints and verdicts follow that route and notation. A correct solution by another route is correct; name the route their course uses.

---

## Part 6 — Practice inheritance

**Goal.** A practice session started from picked propositions carries the course methods of the lesson nodes those propositions came from.

**Files.**
- New `src/core/course-practice.ts`:
  - `nodeAtMessage(messages, tree, messageId): string | null` returns the nodeId of the latest teach tag (`teachTags`, `src/core/units.ts`) at or before the message, ignoring ids not in the tree;
  - `inheritCourseMaterial(picks, lessons): CourseMaterial`.
- `app/api/chats/route.ts` (~l.63–69): when a practice session is created with picks, load the teaching lessons named in the picks' provenance (`GraphNode.provenance`, `src/core/contracts/graph.ts:133`), call `inheritCourseMaterial`, and save it on the new record.
- `src/core/course-notes.ts`: `practiceCourseNotesFor(messages, material)`. It is wired in `chat-handler.ts` for practice turns on the same seam.
- New tests: `tests/course-practice-inherit.test.ts`, `tests/course-practice-notes.test.ts`.

**`inheritCourseMaterial` rules.**
- For each pick and each provenance point in a teaching lesson that has `courseMaterial`, the node is `nodeAtMessage`.
- The methods taken are that node's binding methods. When the node has a conflict, only the chosen route counts; an unresolved conflict contributes nothing.
- The result is one `PropositionMethod` per (proposition, lesson, node, file), with duplicates by (proposition, path, method) dropped.
- The source lessons' binding files are added as `via: "inherited"` with their lesson status copied. `methods` and `conflicts` stay empty.
- Choice 7: this is a snapshot and is never refreshed.

**`practiceCourseNotesFor`:**
- One `course-method` note listing every proposition method, due when no live one carries the same digest.
- A `course-files` note follows the same rule as in teaching.
- Files the practice session reads itself join through Part 2 and are listed, but no worker runs for them (there are no nodes).

**Practice course-method note** (confirmed):

> [Course method] The learner's course solves these propositions as follows. Model solutions, hints and verdicts follow exactly these routes:
> - [<propositionId>] (from node `<nodeId>`): <method> (<file name>, <pages>)

**Tests.**
- A pick whose provenance message sits after a teach tag on `nyquist-zones` inherits that node's method.
- A provenance message before any tag inherits nothing.
- An unticked file in the lesson is not inherited.
- An unresolved conflict contributes nothing, and a chosen one contributes the chosen path.
- The practice note is due once and again after compaction.

---

## Part 7 — Sidebar Files dropdown and opening files

All UI texts in this part, the activity-dock label (choice 11) and the error "Assignment was interrupted." (Part 3) were confirmed by the owner on 2026-11-22.

**Goal.** Under the open session in the sidebar, a dropdown lists its course files with tick, status, nodes and conflict marks. Clicking a file opens it.

**Files.**
- New `components/session-course-files.tsx`, rendered by `components/sidebar.tsx` directly under the `SessionRow` whose `active` is true (~l.771). Nothing renders for inactive rows.
- `electron/preload.cjs` + `electron/main.cjs`: new IPC `lh:open-course-file` with `(chatId, path)`. Main reads the chat's `courseMaterial` through the server API, opens the file with `shell.openPath` only when the path is listed, and otherwise refuses silently. The `window.lh` type in `sidebar.tsx` (~l.70) gains `openCourseFile?: (chatId: string, path: string) => Promise<void>`.
- New tests: `tests/session-course-files.test.tsx`.

**Behavior.**
- **Header row:** "Files (n)", where n counts all listed files. The row is hidden when n is 0. It is collapsed by default, and its open state is remembered per session in localStorage, wrapped in try/catch like `lh:sidebar-open`.
- **Each file row**, in `addedAt` order:
  - a checkbox (PATCH from Part 2, optimistic, reverted on failure);
  - the name (`filePathLabel`) with the full path as tooltip;
  - a status chip: `pending` "waiting", `assigning` "reading…", `assigned` "assigned", `failed` "failed" (tooltip: `error`), `not-assignable` "not assignable";
  - `inherited` files get a small "from lesson" label.
- **Below each assigned file:** the titles of the nodes it supplied a method for, in map order. A node with an unresolved conflict that includes this file shows ⚠ with the tooltip "Your tutor will ask which route your course uses."
- An unticked file's row and nodes are dimmed.
- The component fetches on mount and refetches on `course-material-changed` for this chat and on server resync (`useServerEvent` / `useServerResync`).
- **Click:** with `window.lh?.openCourseFile`, it opens the file. Without it, it copies the path and shows the existing copy hint.

**Tests.**
- The dropdown renders statuses and node titles from a fixture.
- Ticking calls PATCH, and a failed PATCH restores the box.
- A conflict shows ⚠.
- Without the bridge, click copies the path.
- An inactive session renders no dropdown.

---

## Part 8 — Docs, build and install

**Files.**
- `docs/architecture.md`, teaching section: course files, the assignment worker, the course notes, practice inheritance.
- `CONTEXT.md`: **course file**, **course method**, **route conflict**, **course-method note**.
- `src/agent/prompts/README.md`: no change unless fragment files were added.

**Last stage.** `npm run desktop:dist`, then replace `/Applications/LearnHarness.app`.

## Verification (end to end, after Part 8)

Launch the desktop app with `ELECTRON_RUN_AS_NODE` unset and open the Regelungssysteme lesson:

1. The Files dropdown backfills the Skript, `mitschrift_1.pdf` and `mitschrift_2.pdf`. Statuses go from waiting to reading… to assigned, and node titles appear.
2. After the next answer, the model request contains a `course-files` note and `course-method` notes for the current unit's nodes. Check the turn's request in the debug log.
3. Untick one file: on the next turn the course-files note changes and that file's methods are gone from the node notes.
4. Where the Skript and a Mitschrift disagree, the tutor asks via ask_user_question. After the choice, `course_route` is called and the ⚠ clears.
5. Move into the next unit: after the lesson record, the notes for the new unit's nodes are sent.
6. Start practice from propositions of this lesson: the practice request carries the practice course-method note, and the model solutions follow it.
7. Clicking a file opens it in the system viewer.

## Status per part

| Part | Status |
|---|---|
| 1 Course files | not started |
| 2 Persistence, backfill, API | not started |
| 3 Assignment worker | not started |
| 4 Notes and course_route | not started |
| 5 Prompt edits | not started |
| 6 Practice inheritance | not started |
| 7 Sidebar dropdown | not started |
| 8 Docs, build, install | not started |
