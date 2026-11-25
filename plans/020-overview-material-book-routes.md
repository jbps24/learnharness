# 020 — Complete and Overview course material: the book gives the "how" behind the slides

Status: **approved** 2026-11-25. The owner confirmed the decisions, names, every agent-facing text and the forms (Parts 1–4 full, Part 5 light).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill): `ladder queue --plan plans/020-overview-material-book-routes.md --step "Part 1" --step "Part 2" --step "Part 3" --step "Part 4" --step "Part 5"`. Build and install follow after asking (not a ladder part).
3. After each green part, update "Status per part" at the end of this file. Never re-open the owner decisions.

## Context

Plan 007 made course files binding: the reader extracts the course's route per plan node, and the tutor teaches, checks and grades by it. Plan 012 added **Reference** files (the textbook behind the slides): indexed, mapped to nodes by pointers, and consulted only on demand; "the course material wins".

That treats every course-material file the same. In Regelungssysteme the material is a Skript and two Mitschriften: they set what is learned **and** how. In Speech Signal Processing the material is slides (`lecture notes winter term 2018_19.pdf`): they set what is learned, the order, the results and the notation, but mostly not the derivation in between. The book (`Digital Speech Transmission and Enhancement, 2nd Edition.pdf`) is what the slides were built from; it is the reliable source for how the course gets there. Today the tutor fills that "how" from its own knowledge unless it notices a gap.

Measured on the stored Speech lesson (2026-11-25): 28 nodes carry a slide route (760–1,169 chars, median 941; formulas and step order, no derivations), 27 nodes carry book pointers, about 14 book pages per node, ~390 pointed pages in total (with overlap).

## Owner decisions (2026-11-25)

1. **Two kinds of course material**, labelled **Complete** (Skript, Mitschrift: what and how) and **Overview** (slides: what, not how). "Script" is not the name, because Mitschriften are the same kind.
2. **The reader decides, the learner can fix it.** When the reader assigns a material file it also labels it Complete or Overview; the file dialog gets a one-click switch. Files already assigned are labelled once, on the next turn.
3. **Book routes are read once and stored.** For a node whose material is Overview only, the reader reads the node's pointed book sections and stores a **book route** beside the slide route. The tutor gets both in the node's [Course method] note, so it survives unit cuts. Re-read only for nodes a plan rewrite or a pointer change touches.
4. **Split by role.** The Overview material decides what is taught, the order, and the notation and results it shows. The book decides the derivation and the steps in between. Book formulas are translated into the slides' notation.
5. **Which nodes:** only nodes whose binding routes all come from Overview files. A node with any Complete route gets no book route. A node the slides don't cover gets none (the slides decide what is learned).
6. **Practice** sessions carry the book routes of the nodes they inherit, with the same split.
7. Unchanged: exams (plan 010), the [Reference] note and on-demand lookups (plan 012), Complete material, planning (it still plans from course material, not from the book).

## Names and shapes (**confirmed**)

- `CourseFile.materialKind?: "complete" | "overview"`, `CourseFile.materialKindBy?: "reader" | "learner"`. Absent → `"complete"` (today's behaviour) via a new `fileMaterialKind(file)` beside `fileCategory`. Only meaningful when `fileCategory(file) === "material"`.
- `BookRoute { nodeId: string; path: string /* the reference file */; sectionIds: string[] /* the pointer's sections when read */; pages: string /* printed pages, e.g. "pp. 187–194" */; method: string; error?: string }` and `CourseMaterial.bookRoutes?: BookRoute[]`. `method` ≤ `BOOK_ROUTE_CAP = 2_500` chars (slide routes stay at `COURSE_METHOD_CAP = 1_500`: a derivation is longer than a result list). A failed read is stored with `method: ""` and `error`, so it is not retried on every trigger.
- `PropositionMethod.role?: "book"` for practice snapshots.
- Glossary (`CONTEXT.md`): **Complete material** — course material that sets what is learned and how (Skript, Mitschrift). **Overview material** — course material that sets what is learned, the order, results and notation, but not the derivation (slides). **Book route** — the derivation for one Overview node, read from the reference book's pointed sections; binding for how the node is taught.

## Rules for every part

As plans 007/010/012: tests first and locked; **new test files and new helpers only — never reuse or edit existing test fixtures or helpers**; existing tests pass unchanged except those a part names as updated; pure logic in `src/core/`, server wiring in `src/server/` + `app/api/`, agents and workers in `src/agent/`. Texts marked **confirmed** are used verbatim. Line numbers are not given; locate by symbol name.

## Part 1 — Contracts, store, API

Form: full

**Files.** `src/core/contracts/course.ts`, `src/core/index.ts`, `src/store/chats.ts` (material merge keeps the new fields), `app/api/chats/[id]/course/route.ts`, `src/core/course-remove.ts`, `src/core/course-replace.ts`. New tests: `tests/material-kind-contracts.test.ts`, `tests/material-kind-route.test.ts`, `tests/book-route-cleanup.test.ts`.

- Add the fields and types above, `BOOK_ROUTE_CAP`, and `fileMaterialKind(file): "complete" | "overview"` (absent → `"complete"`).
- PATCH `{ path, materialKind: "complete" | "overview" }`: sets `materialKind`, `materialKindBy: "learner"`; same kind → `{ ok: true }` no-op; a file whose category is not `material` → 400. It does **not** re-read the file (the label changes no slide route); it emits `course-material-changed`. More than one of binding, category, retry, materialKind in one body → 400 (extend the existing rule and its error text: `Expected { path: string, binding: boolean }, { path: string, category: "material" | "exam" | "reference" }, { path: string, materialKind: "complete" | "overview" } or { path: string, retry: true }`).
- Cleanup: removing a file (plan 014) removes `bookRoutes` whose `path` is that file; moving a file out of `reference` (PATCH category) removes its `bookRoutes`; moving a file out of `material` clears its `materialKind`/`materialKindBy`; replacing a reference file (plan 015) removes its `bookRoutes` (they are re-read in Part 3); replacing a material file keeps its `materialKind` only when `materialKindBy === "learner"`.

**Tests.** Defaults (`fileMaterialKind` absent → complete); a record without the new fields round-trips unchanged; PATCH materialKind sets both fields, emits, is a no-op for the same kind, 400 on non-material and on combined bodies; each cleanup case above.

## Part 2 — The reader labels course material

Form: full

**Files.** `src/core/course-assign.ts` (instructions, parse, apply), `src/agent/subagents/course-assign.ts` (label-only task), `src/server/course-assign-queue.ts`, `src/server/chat-handler.ts` (backfill trigger). Updated: `tests/course-assign-parse.test.ts` (material results carry `materialKind`). New: `tests/material-kind-assign.test.ts`, `tests/material-kind-backfill.test.ts`.

- The material branch of `COURSE_ASSIGN_INSTRUCTIONS` gains the paragraph below, and the material JSON becomes `{"category":"material","materialKind":"complete"|"overview","nodes":[…]}`. `parseAssignment`: for material, `materialKind` is required and must be one of the two words (a problem otherwise, repaired like today's problems). `applyAssignment` stores it with `materialKindBy: "reader"` unless the file has `materialKindBy: "learner"` (then the learner's label stays and the answer is logged like the category case).
- **Backfill:** a binding material file with status `assigned` and no `materialKind` gets one **label job** in the chat's queue (queued from the same place as backfill today, on the next teaching turn). The label job runs the pdf-reader (PDF) or the text reader (text files) with the label task below, parses `{"materialKind":…}` (one repair attempt), stores it with `materialKindBy: "reader"`. A failed label job leaves the field absent (complete) and logs; it is retried on the next turn at most once per app run per file.
- Activity dock label for a label job: `Checking <file name>`.

**Confirmed — instructions paragraph (material branch):**
> For material, also decide how complete it is. **complete**: it works the course's derivations and procedures through step by step, as a script, lecture notes or a transcript of the lecture (Mitschrift) do. **overview**: it shows what the course covers, its results and formulas, but mostly not the steps between them, as lecture slides usually do. Set "materialKind" to "complete" or "overview".

**Confirmed — label task:**
> Decide only how complete this course file is; do not read it against a plan. Look at its size and at a few pages spread through the file. **complete**: it works the course's derivations and procedures through step by step, as a script, lecture notes or a transcript of the lecture (Mitschrift) do. **overview**: it shows what the course covers, its results and formulas, but mostly not the steps between them, as lecture slides usually do. Return ONE JSON object and nothing else: {"materialKind":"complete"|"overview"}.

## Part 3 — Book routes: which nodes, reading, storing

Form: full

**Files.** New pure `src/core/book-routes.ts`; `src/agent/subagents/book-route.ts` (new worker); `src/server/course-assign-queue.ts` (a book-route job kind in the same per-chat serial queue); `src/server/chat-handler.ts` (triggers); `src/agent/subagents/pdf-reader.ts` only if `runPdfReaderAgent` does not yet take a page spec for its task. New tests: `tests/book-routes-due.test.ts`, `tests/book-routes-queue.test.ts`, `tests/book-route-worker.test.ts`.

- **Due set** (`bookRouteTargets(material, tree)`, pure): a node is **due** when (a) at least one binding material file has a method for it, (b) every binding material file with a method for it is `overview`, (c) a binding reference file has a pointer for it with at least one section. One target per (node, reference file). A stored `BookRoute` satisfies a target when its `path` matches and its `sectionIds` equal the pointer's (in order). Stored routes for dropped nodes, or whose `sectionIds` differ from the node's current pointer (or whose pointer is gone), are removed; a route whose node is merely no longer due (e.g. the learner switched the file to Complete, or unticked it) is kept but unused, so switching back needs no re-read; failed ones (`error`) satisfy the target until the pointer's sections change or the learner presses Retry on the reference file (which clears that file's failed routes).
- **Triggers:** after every finished queue job of the chat (assignment, pointer mapping, label), after a PATCH of `materialKind`, `binding` or `category`, after a reference file's Retry, and after `plan_init` (with the pointers re-mapped first, as today). Each trigger computes the due set, removes stale routes, and enqueues the missing targets (never a target already queued or running).
- **Worker:** per target, the pages are the union of the pointed sections' `startPage–endPage` (PDF page indices). PDF: `runPdfReaderAgent` with that page spec, the node (id, title, summary), the node's binding Overview route(s) as context, and the instructions below. Text reference files (`from: "headings"`): the pointed line ranges as text, through the same no-tools text path the assignment uses. Parse `{"pages":string,"method":string}`, `method` ≤ `BOOK_ROUTE_CAP` (longer → a problem, one repair attempt). `{"pages":"","method":""}` means the sections don't cover the node: stored as a failed route with `error: "not covered"`. Engine: the course-assign engine slot.
- Activity dock label: `Reading <book file name> for <node title>`.

**Confirmed — book-route instructions:**
> You read sections of a reference book for one plan node of a learning application. The course's own material for this node is an overview: it sets what is learned and shows the results, but not how the course gets there. The book is what the course was built from, so its derivation is how the learner has to work this node. Write down the book's route for this node: the derivation or procedure step by step, with its assumptions and intermediate results, in the book's order, so a tutor can teach and grade by it without the book. Cover what the overview route below shows; leave out the book's further topics. Where the overview names the same quantity, use the overview's notation and say where the book's differs. Cite the book's printed pages, e.g. (p. 187). Never fill a gap from your own knowledge. Return ONE JSON object and nothing else: {"pages":string,"method":string}, the method at most 2,500 characters. If these pages don't cover the node, return {"pages":"","method":""}.

## Part 4 — The tutor: notes, prompt, practice

Form: full

**Files.** `src/core/course-notes.ts` (`methodNoteText`, `practiceCourseNotesFor`), `src/core/native-messages.ts` (`newCourseFilesNoteMessage` text), `src/core/course-practice.ts` (`inheritCourseMaterial`), `src/agent/prompts/shared/30-learner-files.md`. New tests: `tests/book-route-notes.test.ts`, `tests/book-route-practice.test.ts`, `tests/book-route-prompts.test.ts`.

- **[Course method] note**, for a node whose binding routes all come from Overview files and that has a stored, non-failed book route from a binding reference file: the text below. Otherwise unchanged (conflict branch included: conflicts are between material files only). Digest as today, so a newly stored book route makes the note due again.
- **[Course material] note:** an Overview file's line gets ` (overview)` appended; Complete files unchanged.
- **Practice:** `inheritCourseMaterial` also copies, for each inherited node, the binding non-failed book routes as `PropositionMethod` entries with `role: "book"`, `path` = the book, `pages`, `method`. The practice note renders them as their own line under the proposition (text below).
- **Prompt:** in "Course material" of `30-learner-files.md`, the paragraph below goes after the first paragraph, and the [Reference] paragraph's sentence "Where a reference uses another route or notation, the course material wins; translate into its notation." becomes "Where a reference uses another route or notation, the course material wins, except for the book routes in [Course method] notes; translate into the course material's notation."

**Confirmed — [Course method] note, Overview node with a book route:**
> [Course method] Node \`<id>\` (<title>): the learner's course material for this node is an overview. What is taught, in which order, and with which results and notation comes from it:
> <slide route> (<slides file>, <pages>)
>
> How the course gets there, from the book it was built from. Teach, check and grade by this derivation, in the notation above:
> <book route> (<book file>, <pages>)

**Confirmed — practice line for a book route:**
> \- [<propositionId>] (from node \`<nodeId>\`), how (book): <book route> (<book file>, <pages>)

**Confirmed — prompt paragraph:**
> Course material is either complete (a script or a Mitschrift: it sets what is learned and how) or an overview (marked "(overview)" in the [Course material] note, usually slides: it sets what is learned, the order, the results and the notation, but not how to get there). For an overview node, the [Course method] note also carries a book route: the derivation from the book the course was built from. Teach, check and grade that derivation as the course's route, in the overview's notation. Where an overview node has no book route, fill the steps as described above and say so.

## Part 5 — UI and docs

Form: light

**Files.** `components/session-course-files.tsx`, `components/course-file-details-dialog.tsx`, `docs/architecture.md`, `CONTEXT.md`. Updated: none. New: `tests/material-kind-panel.test.tsx`, `tests/book-route-dialog.test.tsx`.

- **Files panel:** in the "Course material" group, an assigned file shows a chip `Complete` or `Overview` after its status chip.
- **Dialog, material file:** a button `Mark as Overview` / `Mark as Complete` (the other kind) beside the existing move buttons, sending the Part 1 PATCH. For an Overview file, under each node's slide route: `Book route (<book file name>, <pages>)` with the route text; `Reading the book…` while that target is queued or running; `Book route failed: <error>` for a failed one; nothing when the node has no pointer.
- **Dialog, reference file:** unchanged except that a node whose book route is stored shows `Book route stored` after its sections.
- Docs: `docs/architecture.md` (material kinds, label job, book routes: due set, triggers, worker, notes, practice); `CONTEXT.md` glossary entries from "Names and shapes".

## Last stage — build and install (after the parts, not a ladder part)

`npm run desktop:dist`, then ask the owner before replacing `/Applications/LearnHarness.app`.

## Verification (after Part 5)

Desktop app (`ELECTRON_RUN_AS_NODE` unset):
1. Speech Signal Processing: send a turn. The slides get the `Overview` chip (label job, `Checking lecture notes…`), then `Reading Digital Speech… for <node>` jobs run for the overview nodes with pointers. The slides' dialog shows a book route per node.
2. The next teaching turn's request (debug log) carries [Course method] notes in the two-part form for the current unit, and `(overview)` in the [Course material] note.
3. Regelungssysteme: the Skript and both Mitschriften get `Complete`; no book-route jobs; notes unchanged.
4. Switch the Speech slides to Complete: the notes lose the book part (routes stay stored but unused). Switch back: they return without a re-read.
5. Create a practice session from Speech nodes: the practice note carries `how (book)` lines.
6. Gates: `npm run typecheck`, `npm run lint`, `npm test`.

## Status per part

| Part | Status |
|---|---|
| 1 Contracts, store, API | green (full), build-review/20261125-140722-020-part-1; BookRoute shape fixed to plan in build-review/20261125-163529-020-part-1 (--issue) |
| 2 Reader labels material | green (full), build-review/20261125-143502-020-part-2; label backfill runs at the end of every turn, max 2 attempts per file |
| 3 Book routes | green (full), build-review/20261125-145447-020-part-3; one `npm test` hung 300 s and was killed |
| 4 Tutor notes, prompt, practice | green (full), build-review/20261125-154247-020-part-4 |
| 5 UI and docs | green (light), build-review/20261125-161755-020-part-5; open: 'Reading the book…' also shows for a pointed node that is not due (no queued/running signal) |
| Build and install | not started |
