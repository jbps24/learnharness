# 010 — Altklausuren: exam patterns shape the practice problems

Status: **approved** 2026-11-23. Runs after plan 009 (it extends 009's details dialog).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run Parts 1–4 through the ladder (`execute-plan` skill) as one queue; Part 5 alone with `--no-tests-first`.
3. After each part is green, update "Status per part" below.
4. Rules for every part: existing tests keep passing unchanged, except the tests a part names as updated. New test helpers only; do not reuse existing fixtures. The texts marked **confirmed** are used verbatim.

## What this builds

The course files of plan 007 (Skript, Mitschrift) decide **how** the tutor teaches and grades: the course method per plan node. The learner also has Altklausuren (past exams). They should decide **what practice problems look like**: practice poses new problems in the style of the exams, on the propositions being practiced.

- A course file is now either **course material** (as today) or an **exam**. The background reader sorts a new file itself; the learner can move it with one click.
- For an exam, the reader stores **exam patterns** per plan node: the task's source (e.g. `WS22 A3b`), pages, the pattern (task type, what is given, what is asked, the answer format, typical numbers, points) and, when the file has a solution, how points are given.
- Practice sessions inherit the exam patterns of their picked propositions, like the course methods, and pose problems in that shape by default.
- Teaching does not change: exam files never reach the teaching tutor.

## Owner decisions (2026-11-23)

1. Practice builds **new** problems in the style of the exams (task type, format, notation, givens, difficulty); it does not reuse the real tasks.
2. Exams are added in the lesson like any course file. The Files panel shows two groups, **Course material** and **Exams**; the reader sorts each new file, the learner can move it.
3. The reader keeps **task patterns per plan node** (with the source task).
4. Exam shape is the **default** for problems on nodes with patterns; the warm-up recall drills and the hint ladder stay; each exam-style problem names its model.
5. **Practice only**: teaching prompts and notes are unchanged.
6. A solution in an exam file yields **grading hints** (which steps earn points, the expected final form). Routes still come only from course material.
7. The practice picker marks propositions the exams cover with a badge `exam ×N`.

## Glossary (for CONTEXT.md in Part 5)

- **Exam file**: a course file that is a past exam of the course (Altklausur). It shapes practice problems; it never supplies a course method.
- **Exam pattern**: what one exam task asks about one plan node — task type, givens, what is asked, answer format, typical numbers, points, its source task — and, when the file has a solution, how points are given.

## Part 1 — Contracts, store and API

**Files.** `src/core/contracts/course.ts`, `src/store/chats.ts` (the course material merge), `app/api/chats/[id]/course/route.ts` (PATCH), `src/core/index.ts`. New tests: `tests/exam-contracts.test.ts`, `tests/exam-category-route.test.ts`.

**Contracts.**
- `CourseFile` gains `category?: "material" | "exam"` (absent means `"material"`, so every existing record reads as before) and `categoryBy?: "reader" | "learner"`.
- New `ExamPattern { nodeId: string; path: string; source: string; pages?: string; pattern: string; grading?: string }`. `source` is the task as the file names it (`A3b`, `Aufgabe 3 b)`), prefixed with the exam's own label when the file has one (`WS22 A3b`). `pattern` and `grading` are each at most `EXAM_PATTERN_CAP = 1_200` characters.
- `CourseMaterial` gains `examPatterns?: ExamPattern[]` (absent means none) and, for practice sessions, `propositionExamPatterns?: Array<ExamPattern & { propositionId: string; lessonId: string }>`.
- New helper `fileCategory(file: CourseFile): "material" | "exam"` (returns `"material"` when absent).

**PATCH** `/api/chats/:id/course` accepts `{ path, category: "material" | "exam" }` besides today's `{ path, binding }`:
- Unknown path: 404. Same category as now: 200, nothing changes.
- Otherwise: set `category`, `categoryBy: "learner"`, `status: "pending"`, remove that file's `methods`, `examPatterns` and its paths from `conflicts` (a conflict left with fewer than two paths is removed), save, emit `course-material-changed`, and hand the path to the assignment queue (Part 2).
- Both keys in one body: 400.

**Tests.** `fileCategory` defaults; PATCH moves a file (fields reset, methods/patterns/conflicts cleaned, event emitted, queued); same category is a no-op; unknown path 404; both keys 400; a record without `category` round-trips unchanged.

## Part 2 — The reader sorts and reads exams

**Files.** `src/core/course-assign.ts`, `src/agent/subagents/course-assign.ts`, `src/server/course-assign-queue.ts`. Updated tests: `tests/course-assign-parse.test.ts`, `tests/course-assign-queue.test.ts` (new answer shape). New test: `tests/exam-assign.test.ts`.

**Prompt.** `COURSE_ASSIGN_INSTRUCTIONS` gets a first paragraph and the exam branch (**confirmed** after the owner reads the draft below):

> First decide what this file is. A past exam or exam-like task sheet of the course (tasks with points or a time limit, "Klausur", "Prüfung", "Exam", possibly with a solution) is an **exam**. Anything else (script, lecture notes, exercise solutions that teach a method) is **material**. When the task states the category, use that one.
>
> For **material**, do what follows below and set `"category":"material"`.
>
> For an **exam**, set `"category":"exam"` and, for every plan node one of its tasks exercises, write one entry per task: `source` (the task as the file names it, with the exam's label if it has one, e.g. "WS22 A3b"), `pages`, `pattern` (the task type; what is given; what is asked; the expected answer format such as a sketch, a value, a short justification; typical numbers or functions; the points), and, only when the file contains a solution, `grading` (which steps earn how many points and the expected final form). Write in the file's language. Never invent a solution the file does not contain.

- The JSON becomes `{"category":"material"|"exam","nodes":[…]}`; for exams each node entry is `{"nodeId","source","pages","pattern","grading"?}` and `sameRouteAsExisting` is absent.
- When `categoryBy === "learner"`, the task line states `This file is a <category>; do not decide again.`
- `parseAssignment` accepts both shapes; problems: missing or unknown `category`, an exam entry without `source` or `pattern`, `pattern`/`grading` over the cap, unknown node ids (as today).
- `applyAssignment`: material as today; an exam sets `category: "exam"` (`categoryBy` stays `"learner"` when it was), stores the entries as `examPatterns` (replacing the file's old ones), adds no methods and no conflicts.

**Tests.** Parse of both shapes and each problem; apply of an exam answer (patterns stored, no methods/conflicts, category set); a learner-set category is passed in the task and not overwritten by a different reader answer (the answer's category is ignored, logged as a problem-free mismatch); a material answer for a file the reader called exam before replaces its patterns with methods.

## Part 3 — Practice: inherit the patterns, the note, the prompt

**Files.** `src/core/course-practice.ts`, `src/core/course-notes.ts`, `src/core/native-messages.ts` (new note type `exam-pattern`, neutral, in the same skip lists as `course-method`), `src/server/unit-cut.ts` (`withoutMarkers`), `src/core/input-events.ts`, `src/agent/prompts/practice/00-base.md`, `src/agent/prompts/practice/10-doctrine.md`. Also `src/core/course-notes.ts` `courseNotesFor` (teaching): exam files are left out of the course-files note and never produce method notes. Updated test: `tests/course-practice-inherit.test.ts` (new field in the snapshot). New tests: `tests/exam-practice-inherit.test.ts`, `tests/exam-practice-notes.test.ts`, `tests/exam-teaching-excluded.test.ts`, `tests/exam-prompts.test.ts`.

**Inheritance.** `inheritCourseMaterial` also copies, per pick and lesson node, the binding exam files and their `examPatterns` at that node into `propositionExamPatterns` (deduplicated by proposition + path + source).

**Note.** `practiceCourseNotesFor` adds one `exam-pattern` note when `propositionExamPatterns` is non-empty (same digest rule as the course-method note), text **confirmed**:

> [Exam pattern] The learner's past exams ask about these propositions as follows. Pose problems on them in this shape (task type, givens, answer format, notation, level), with new numbers and functions, and name the model in the statement, e.g. "in the style of WS22 A3b". Where grading is given, model solutions and verdicts follow it.
> - [<propositionId>] <source> (<file name>, <pages>): <pattern> Grading: <grading>

**Prompt edits** (**confirmed** texts):
- `practice/00-base.md`, after "Course methods": **Exam patterns.** When an [Exam pattern] note covers a proposition, a problem on it takes the exam's shape by default: the same task type, givens, answer format and level, with new numbers. Name the model in the statement. The warm-up recall demands and the hint ladder stay as the doctrine says. The route still follows the [Course method] note.
- `practice/10-doctrine.md`, section I, the "Not an exam" bullet gains: Where the learner's past exams set a task shape, you build within that shape; the strengthening choices (target, mode, difficulty step) stay yours.

**Tests.** Inheritance copies patterns only for binding exam files and only at the pick's node; dedup; the note text and digest; no note without patterns; teaching notes leave exam files out; both prompt edits present in the composed practice prompt and absent from the teaching prompt.

## Part 4 — UI: two groups, moving a file, the picker badge

**Files.** `components/session-course-files.tsx`, `components/course-file-details-dialog.tsx` (from plan 009), `components/new-session.tsx`, new route `app/api/practice/exam-coverage/route.ts`. Updated test: `tests/session-course-files.test.tsx` (groups). New tests: `tests/exam-files-panel.test.tsx`, `tests/exam-coverage-route.test.ts`, `tests/exam-picker-badge.test.tsx`.

- **Panel.** Under "Files (n)", two sub-headings `Course material` and `Exams`, each listing its files as in plan 009 (a group with no files is not shown).
- **Dialog.** For an exam file the body lists, per node in plan-map order, the node title and one block per pattern: source, pages, the pattern text and, when present, `Grading:` and the grading text. A button `Move to Exams` / `Move to Course material` at the bottom sends the PATCH of Part 1; while the file is re-read the dialog shows its new status.
- **Coverage route.** `GET /api/practice/exam-coverage` returns `{ counts: Record<propositionId, number> }`: for each proposition with provenance in a teaching lesson, the number of distinct binding exam files with a pattern at the lesson node of that provenance (`nodeAtMessage`). Propositions with 0 are left out.
- **Picker badge.** In the practice picker each proposition with a count shows a small muted badge `exam ×N` after its text. No automatic selection.

**Tests.** Groups render and hide; the dialog's exam blocks and the move button's PATCH body; coverage counts (distinct files, binding only, teaching lessons only); the badge text and its absence at 0.

## Part 5 — Docs, build and install (`--no-tests-first`)

- `docs/architecture.md`: exam files and exam patterns in the course files section; practice inheritance of patterns; the `exam-pattern` note.
- `docs/plugin-api/native-messages.md`: the new `customType` in both unions.
- `CONTEXT.md`: **Exam file**, **Exam pattern** (glossary above).
- Last stage: `npm run desktop:dist`, then replace `/Applications/LearnHarness.app` (ask the owner to quit the app first).

## Status per part

| Part | Status |
|---|---|
| 1 Contracts, store, API | not started |
| 2 Reader sorts and reads exams | not started |
| 3 Practice inheritance, note, prompts | not started |
| 4 Panel groups, move, picker badge | not started |
| 5 Docs, build, install | not started |
