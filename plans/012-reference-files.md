# 012 — Reference files: the book behind the slides, looked up on demand

Status: **approved** 2026-11-24. The owner confirmed the decisions below and every agent-facing text marked **confirmed**.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–5 through the ladder (`execute-plan` skill) as one queue; Part 6 alone with `--no-tests-first`.
3. After each part is green, update "Status per part" below.

## Context

Course files (plan 007) are binding course material: the reader extracts the course's route per plan node, the tutor plans, teaches and grades by it. Exams (plan 010) shape practice problems. That works for Regelungssysteme (Skript + `mitschrift_1/2.pdf` = course material, unchanged by this plan).

Speech Signal Processing adds a third kind: the slides (`lecture notes winter term 2018_19.pdf`, 223 pp.) are the course material, but the textbook they were built from (`Digital Speech Transmission and Enhancement, 2nd Edition.pdf`, 595 pp.) must **not** set what is learned. It should be consulted when a question goes deeper than the slides or the slides leave something open. Today, on the Speech session's next turn, backfill would add the book as binding material and the reader would extract "course routes" from it.

## Investigation: TOC index + on-demand reading vs. one read-through

Measured on the actual files:
- The book carries a full PDF outline: **388 entries**, chapter → section (e.g. `6.2 Optimal Prediction Coefficients for Stationary Signals p205`), with exact page targets and page labels (printed p. 1 = PDF p. 19). A section spans ~5–15 pages. Extracting it is deterministic and free (`pdfjs getOutline/getDestination/getPageIndex/getPageLabels`, already a dependency). The slides have no outline (not needed: they stay material).
- A read-through would mean ~600 pages, many math-heavy (equations need rendered pages to be read correctly), i.e. several hundred thousand to over a million tokens per book per lesson, redone on plan rewrites. Its output would be capped per-node summaries (1,500 chars), which drop exactly the derivations a "deeper" question needs, and it cannot anticipate questions not yet asked.

**Recommendation: save the map, not the content.** Once per file: the table of contents (from the outline; the reader reads the printed Contents pages only when there is no outline) plus, per plan node, pointers to the 1–3 book sections that cover it (one cheap model call over the TOC and node titles, no book pages read). At teaching time the tutor sends a `pdf` job scoped to the pointed pages (~10 pp.). Lookup briefs live in the transcript only; not cached.

## Owner decisions (2026-11-24)

1. Name: **Reference** (Files group "Reference", note tag `[Reference]`, glossary term **Reference file**).
2. The reader sorts: a published textbook/reference work that is not the course's own script, slides or notes → Reference, and it stops there (no reading against the plan). The learner can move a file with one click (as for exams).
3. The tutor consults a Reference on its own judgment: when the learner asks something the course material doesn't answer, or the material leaves a step/derivation/explanation open (before filling from its own knowledge), and whenever the learner asks. It never plans from it, adds nodes for it, or teaches its extra topics unasked.
4. Teaching only. Practice sessions are unchanged (no inheritance of reference pointers).
5. Course material (primary) and exams behave exactly as today.

## Rules for every part

As plans 007/010: tests first and locked; new test files and helpers only; existing tests pass unchanged except those a part names as updated; pure logic in `src/core/`, server wiring in `src/server/` + `app/api/`, agents in `src/agent/`. Texts marked **confirmed** below are used verbatim.

## Part 1 — Contracts, store, API

**Files.** `src/core/contracts/course.ts`, `src/store/chats.ts` (material merge), `app/api/chats/[id]/course/route.ts`, `src/core/index.ts`. New tests: `tests/reference-contracts.test.ts`, `tests/reference-category-route.test.ts`. Updated: `tests/exam-category-route.test.ts` only if its 400-message assertion changes.

- `CourseFile.category?: "material" | "exam" | "reference"`; `fileCategory` returns it (absent → `"material"`).
- New `ReferenceSection { id: string; title: string; level: number; startPage: number; endPage: number; label?: string }` — `id` is the section number when the title has one (`"6.2"`), else `s<index>`; pages are PDF page indices (what the pdf tools use); `label` is the printed range (`"pp. 187–192"`) when page labels exist.
- `CourseMaterial.referenceIndex?: Array<{ path: string; from: "outline" | "contents" | "headings"; sections: ReferenceSection[] }>` and `referencePointers?: Array<{ nodeId: string; path: string; sectionIds: string[] }>`. Caps: `REFERENCE_SECTIONS_CAP = 800`, levels ≤ 3, ≤ 3 sections per node and file.
- PATCH accepts `category: "reference"`; moving a file in or out also removes its `referenceIndex` and `referencePointers` entries (besides today's methods/patterns/conflicts cleanup), sets `pending`, re-queues.

**Tests.** Defaults; PATCH to/from reference cleans all per-file data, emits, queues; same-category no-op; a record without the new fields round-trips unchanged.

## Part 2 — Table of contents extraction

**Files.** `src/agent/subagents/pdf-ops.ts` (new `pdfOutline(path)`), new pure `src/core/reference-toc.ts` (flatten, number, end pages, caps; markdown/tex headings → sections), new `src/agent/subagents/reference-toc.ts` (fallback reader). New tests: `tests/reference-toc.test.ts`, `tests/pdf-outline.test.ts` (small generated PDF with an outline).

- **Outline** (`from: "outline"`): walk `getOutline()`, resolve each dest to a page index, drop entries without a page; `endPage` = next entry at the same or a higher level − 1, the last = page count; labels from `getPageLabels()`.
- **No outline, PDF** (`from: "contents"`): the pdf-reader loop with the **confirmed** task below returns the TOC as JSON with PDF page indices; parsed and checked by `reference-toc.ts` (pages increasing, within the document).
- **Text files** (`.md .markdown .txt .tex`, `from: "headings"`): `#` headings / `\chapter \section \subsection`; "pages" are line numbers.

**Confirmed — contents task:** "Find this document's table of contents (usually within the first 30 pages). Return ONE JSON object: {"sections":[{"title":string,"level":1|2|3,"startPage":number}]}, with startPage as the PDF page index the pdf tools use — locate at least one section heading to find the offset between printed and PDF page numbers. Leave out front matter and the index."

## Part 3 — The reader sorts references and maps nodes to sections

**Files.** `src/core/course-assign.ts` (instructions, parse, apply), `src/agent/subagents/course-assign.ts`, `src/server/course-assign-queue.ts`, new pure `src/core/reference-pointers.ts`. Updated: `tests/course-assign-parse.test.ts` (third category). New: `tests/reference-assign.test.ts`, `tests/reference-pointers.test.ts`.

- `COURSE_ASSIGN_INSTRUCTIONS` gains the reference branch (**confirmed**): "A published textbook or reference work (ISBN, publisher, edition, numbered chapters) that is not the course's own script, slides or lecture notes is a **reference**. For a reference, return {"category":"reference","nodes":[]} at once; do not read it against the plan." The task line for a learner-set category also allows `reference`.
- On a `reference` result: build the index (Part 2) if the file has none, then run the **pointer mapper**: one model call (course-assign engine slot, no tools) with the TOC lines (`id title (pp.)`) and the target nodes (id, title, summary, unit). Parse: known node ids, known section ids, ≤ 3 per node; one repair attempt as today. Store `referencePointers` for the targets; status `assigned`. No methods, no conflicts, no exam patterns.
- Triggers reuse `assignmentTargets`: a new file → all nodes; `plan_init` → changed nodes only, re-mapped from the stored index (no re-extraction); dropped nodes' pointers removed.
- Activity dock label as today ("Assigning <file> to the plan").

**Confirmed — mapper instructions:** "You map a lesson's plan nodes to the sections of a reference book, using only its table of contents. For each node, list up to 3 of the most specific sections whose content covers it, most relevant first. Leave out nodes no section covers. Return ONE JSON object and nothing else: {"nodes":[{"nodeId":string,"sections":[sectionId]}]}."

## Part 4 — The tutor: reference note, scoped lookups, prompts

**Files.** `src/core/course-notes.ts`, `src/core/native-messages.ts` (customType `reference`, neutral, `display:false`, same skip lists as `course-method`: `src/core/input-events.ts`, `src/server/unit-cut.ts` `withoutMarkers`), `src/server/chat-handler.ts` (teaching turns only), `src/agent/tools/jobs.ts` + `src/agent/subagents/runner.ts` + `pdf-reader.ts` (optional `pages`), `src/agent/prompts/shared/30-learner-files.md`, `src/agent/prompts/teacher/10-planning.md`. New tests: `tests/reference-notes.test.ts`, `tests/reference-pdf-pages.test.ts`, `tests/reference-prompts.test.ts`.

- `courseNotesFor` emits one `reference` note when binding reference files exist, for the current unit's nodes (same scope rule as course methods), due when no live note carries its digest. Reference files stay out of the `[Course material]` note (already filtered by category).
- `pdf` job input gains `pages?: string` (spec). The reader prompt then says "Read within pages <spec> (the section the teacher points to); widen only if the answer is clearly outside." and `pdf_info` reports only those pages.
- Planning bullet: "read the course files" → "read the course material files"; reference files are not read for planning.

**Confirmed — reference note:**
> [Reference] Reference files for this course. They are not course material: they never set what is learned.
> - <path>
>
> Where to look for this unit's nodes:
> - `<nodeId>` (<title>): <file name> §<id> <section title> (pages <start>–<end>, printed <label>)
>
> When the learner asks something the course material doesn't answer, or the material leaves a step open, look it up here first: a pdf job with this file, these pages and your question.

**Confirmed — shared prompt paragraph** (appended to "Course material"):
> Files in a [Reference] note, usually the textbook behind the slides, are not course material. They never set what is learned: don't plan from them, add nodes for them, or teach their further topics unasked. Consult them when the learner asks something the course material doesn't answer, or when the material leaves a step, derivation or explanation open, before you fill it from your own knowledge, and whenever the learner asks: dispatch a pdf job on the pages the note points to and tell the learner you are checking the book. Where a reference uses another route or notation, the course material wins; translate into its notation. Cite the reference's pages.

## Part 5 — UI

**Files.** `components/session-course-files.tsx`, `components/course-file-details-dialog.tsx`. Updated: `tests/exam-files-panel.test.tsx` (move buttons). New: `tests/reference-files-panel.test.tsx`.

- Third group **Reference** after "Exams" (hidden when empty).
- Dialog for a reference file: per node (map order) the pointed sections `§6.2 Optimal Prediction… (pp. 205–210)`; a line "Table of contents: N sections (from outline|contents|headings)".
- Move buttons: one per other category — `Move to Course material`, `Move to Exams`, `Move to Reference`.

## Part 6 — Docs, build, install (`--no-tests-first`)

`docs/architecture.md` (reference files, index, pointers, scoped pdf jobs), `docs/plugin-api/native-messages.md` (`reference` customType), `CONTEXT.md` (**Reference file**: a course file the course was built from but that does not set what is learned; consulted for depth, never binding. **Reference pointer**: the sections of a reference file that cover one plan node). Last stage: `npm run desktop:dist`, ask the owner to quit the app, replace `/Applications/LearnHarness.app`.

## Verification (after Part 6)

Desktop app (`ELECTRON_RUN_AS_NODE` unset):
1. Open the Speech Signal Processing lesson and send a turn: Files backfills the slides (Course material → reading → assigned) and the book (→ **Reference**, assigned quickly, no long read). The dialog shows ~388 sections from the outline and section pointers per node.
2. The turn's request (debug log) has a `[Reference]` note with this unit's pointers and no book in the `[Course material]` note or `[Course method]` notes.
3. Ask a question beyond the slides: the tutor dispatches a `pdf` job with the book and a page range; the brief cites book pages; the plan map is unchanged.
4. Move the book to Course material and back: data resets and is rebuilt.
5. Regelungssysteme: Files, notes and exams unchanged; a practice session from either lesson carries no reference note.
6. Gates: `npm run typecheck`, `npm run lint`, `npm test`.

## Status per part

| Part | Status |
|---|---|
| 1 Contracts, store, API | green, build-review/20261124-084748-012-part-1 |
| 2 Table of contents extraction | green, build-review/20261124-091014-012-part-2 |
| 3 Reader sorts, node pointers | green, build-review/20261124-092347-012-part-3; skip-reader re-map + flip cleanup fix build-review/20261124-102351-012-part-3 |
| 4 Tutor note, scoped lookups, prompts | green, build-review/20261124-094547-012-part-4 |
| 5 UI | green, build-review/20261124-101036-012-part-5 |
| 6 Docs, build, install | green, build-review/20261124-103542-012-part-6 |
