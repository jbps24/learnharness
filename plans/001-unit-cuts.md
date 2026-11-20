# 001 — Unit cuts: teach a lesson in units with a durable lesson record

Status: **draft, awaiting owner approval** (no part started).

## Starting a session on this plan

1. Until this line says **approved**, do not run any part. Walk the owner through "Spec-level choices for owner review" and every **DRAFT** text in the part about to run, one question at a time (AGENTS.md "No guessing"). Write the answers into this file, then mark it approved.
2. Run parts through the ladder (`execute-plan` skill): `ladder queue --plan plans/001-unit-cuts.md --step "Part 1" …`. `.ladder.toml` is filled in; show it to the owner once before the first chunk. Parts 7 and 9 take `--no-tests-first`.
3. After each green part, update "Status per part" below. Never re-open the decisions the tickets hold.

## What this builds

Long teaching lessons grow their model context ~9k tokens per plan node until repeated compaction loses track of what was taught. This plan lets the teacher group plan nodes into ordered **units** at planning time. When the teacher moves into the next unit, the app cuts the model context in place: everything before the move is replaced by a **lesson record**. The app computes the record's progress facts from the transcript, and a summarizer call writes only the judgment of the learner. Nothing is deleted, and the learner keeps the whole transcript.

Vocabulary (repo-root `CONTEXT.md`): **unit**, **current unit**, **unit cut**, **lesson record**, **compaction summary**, **node status**.

Decisions this plan implements (each ticket holds the full rationale; do not re-open them):

- `.scratch/node-contexts/issues/03-grilling-course-record.md`: the lesson record (amended by 10).
- `.scratch/node-contexts/issues/09-grilling-planner-parts.md`: units in the plan (amended by 08).
- `.scratch/node-contexts/issues/10-grilling-cut-trigger.md`: when and how the cut fires.
- `.scratch/node-contexts/issues/08-grilling-convert-existing.md`: converting old lessons.
- `.scratch/node-contexts/issues/11-grilling-cut-visibility.md`: what the learner sees.
- Map: `.scratch/node-contexts/map.md`.

Out of scope: practice sessions; per-unit source scoping; trimming tool output; showing the lesson record to the learner.

## Rules for every part

- Tests are new files under `tests/` (flat, `*.test.ts` / `*.test.tsx`, run by `npm test` = `NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx`). **Do not reuse or edit existing test fixtures or helpers**; write new helpers inside the new test files. Existing tests must keep passing unchanged, except where a part names a test it updates.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`.
- Pure logic lives in `src/core/` (no server imports); server wiring in `src/server/`; agent tools in `src/agent/`.
- Every agent-facing error message is exact text from this plan (drafts are marked **DRAFT**; the owner may edit them before the part runs).
- Line numbers below were read on `feat/antigravity-cli` @ 0af4fb2; re-locate by symbol name if they moved.

## Spec-level choices for owner review

The map settled the design. These smaller choices were made while writing the spec and need your yes before Part 1 runs:

1. `%% source:` outside a unit, or twice inside one unit, is a parse problem (not silently ignored).
2. A unit cut may finish several units at once. This only happens for converted lessons, where the current unit can already be unit 3.
3. The summarizer's raw-span input "fits" when `summaryRequestFits(prompt)` (Antigravity) passes, or otherwise when `ceil(prompt.length / 4) <= thresholdTokens`. If it doesn't fit, the fallback is the in-unit compaction summary plus the raw messages after its kept boundary. If that doesn't fit either, the cut fails (no cut).
4. Check lines cover built-in `quiz`/`explain` teach calls only. Plugin teach questions still move node status but produce no check line.
5. The lesson record marker's `content` is the full rendered record at cut time, a snapshot like the compaction summary. Live progress after the cut is in the kept transcript.
6. The conversion note's customType is `units-note`. It is model-facing and not shown in the transcript.
7. Unit cut and compaction share one per-chat registry and one running-state event (`compaction-changed`, gaining an optional `unit` field).

---

## Part 1 — Units in the plan map (parser, tree, plan_init)

**Goal.** `plan_init` accepts flat mermaid subgraphs as units and stores them on the tree. A plan without subgraphs behaves exactly as today.

**Files.**
- `src/agent/tools/mermaid-plan.ts`: parse subgraphs.
- `src/core/contracts/plan.ts`: `PlanUnit`, `PlanTree.units?`.
- `src/core/plan-tree.ts`: `createTree(nodes, edges, units?)` validation.
- `src/agent/tools/plan.ts`: pass units through; result text; tool description.
- New tests: `tests/plan-units-parse.test.ts`, `tests/plan-units-tree.test.ts`, `tests/plan-init-units.test.ts`.

**Contract.**

```ts
// src/core/contracts/plan.ts
export interface PlanUnit {
  id: string;          // node-slug rule, permanent, distinct from every node id
  title: string;       // required, lenient single line
  source?: string;     // free text from `%% source:`; trimmed; absent when not given
  nodeIds: string[];   // in first-appearance order
}
export interface PlanTree { nodes: PlanNode[]; edges: PlanEdge[]; units?: PlanUnit[]; version: number }
```

`ParsedPlan` gains `units?: PlanUnit[]`. `units` is **absent** (not `[]`) when the block has no subgraph.

**Parser rules** (all problems are collected, each prefixed `line N:` like today's):

1. `subgraph <id>[<title>]`, `subgraph <id>["<title>"]` and `subgraph <id>("<title>")` open a unit. The title is parsed exactly like a node label (quote pair stripped). Leading/trailing whitespace is ignored and the keyword is case-insensitive.
2. `end` (case-insensitive, alone on the line) closes the open unit.
3. Problems:
   - `subgraph` while a unit is open → `line N: units can't be nested — close \`<open id>\` with \`end\` first.`
   - `end` with no open unit → `line N: \`end\` closes nothing — no unit is open.`
   - A unit still open at the end of the block → `line N: unit \`<id>\` is never closed — add \`end\`.` (N = the subgraph line).
   - A unit id that breaks the slug rule → the node-slug message with "unit id" in place of "node id".
   - A unit without a title (`subgraph id`) → `line N: unit \`<id>\` needs a title — \`subgraph <id>[Short Title]\`.`
   - A duplicate unit id → `line N: unit id \`<id>\` is used twice.`
   - A unit id equal to a node id → `unit id \`<id>\` is also a node id — ids must be distinct.`
   - A unit with no nodes → `line N: unit \`<id>\` has no nodes.`
4. `%% source: <text>` inside an open unit sets that unit's `source` (text trimmed; an empty text counts as absent).
   - A second `%% source:` in the same unit → `line N: unit \`<id>\` already has a source.`
   - A `%% source:` outside any unit → `line N: \`%% source:\` belongs inside a unit (between \`subgraph\` and \`end\`).`
   - Every other `%%` line stays a comment.
5. **Membership: first appearance.** A node belongs to the unit that is open on the line where the node id first appears, whether in a node line or as an edge endpoint. Later mentions anywhere are references only.
6. A labelled node line (`id[title]`, `id("title")`) for an id that already belongs to a different unit → `line N: node \`<id>\` is already in unit \`<u>\` — a node belongs to exactly one unit.` Bare references and edge endpoints never trigger this.
7. When at least one unit exists, every node first appearing outside any unit → one problem: `nodes outside any unit: a, b — when the plan has units, every node must be inside one.`
8. **Order check** (when units exist): units are ordered by their `subgraph` line. For every edge `from --> to`, `unitIndex(from) > unitIndex(to)` → `edge \`<from>\` --> \`<to>\`: the prerequisite is in a later unit (\`<uf>\` comes after \`<ut>\`) — move it to the same or an earlier unit.`
9. Remove "subgraphs" from the list of unsupported constructs in the existing parse-failure message (styles and classes stay unsupported).

**`createTree(nodes, edges, units?)`** (defence in depth, throws `PlanTreeError`):
- When `units` is given: unit ids are unique, slug-valid, distinct from node ids, and titles are non-empty; every node is in exactly one unit; every unit `nodeIds` entry is a real node; no edge's prerequisite sits in a later unit.
- The tree copies units (`{...u, nodeIds: [...u.nodeIds]}`). When `units` is absent, the field stays absent.

**plan_init.**
- Passes `parsed.plan.units` to `createTree` and saves the tree as today.
- The result text adds `unitIds` (ordered) when units exist: `{"ok":true,"nodeIds":[…],"unitIds":[…],"reminder":…}`. `details.tree` carries units.
- Tool description and the `mermaid` parameter description, **DRAFT**:
  > Group nodes into ordered units with flat mermaid subgraphs: `subgraph slug[Unit Title]` … `end`, one coherent topic each, optional `%% source: <where in his material>` inside. Every node in exactly one unit; a prerequisite never sits in a later unit. A plan without subgraphs is one unit.

  Replace "no subgraphs, styles, or classes" with "no styles or classes".

**Examples (must be tests).**

```
graph TD
  subgraph basics[Grundlagen]
    %% source: Skript Kap. 1, S. 3–20
    ode1[ODEs erster Ordnung] --> expeig[Eigenwerte]
  end
  subgraph stab[Stabilität]
    poles[Pole] --> loop[Regelkreis]
  end
  expeig --> poles
```
→ ok; `units = [{id:"basics", title:"Grundlagen", source:"Skript Kap. 1, S. 3–20", nodeIds:["ode1","expeig"]}, {id:"stab", title:"Stabilität", nodeIds:["poles","loop"]}]`. Here `expeig --> poles` sits at top level but references nodes that already belong to units, so it is valid.

- The same block with `poles --> expeig` added → order-check problem naming `poles`/`expeig`.
- `graph TD\n a --> b\n subgraph u1[U]\n c\n end` → "nodes outside any unit: a, b".
- `graph TD\n a --> b` → ok with `units` absent.
- Edge cases to test: nested subgraph; stray `end`; unclosed unit; unit id `Basics` (slug); unit id equal to a node id; empty unit; two `%% source:` in one unit; `%% source:` at top level; a node labelled in two units; a node first mentioned as an edge endpoint inside unit 2 that already got its membership in unit 1 (stays in unit 1, no problem).

---

## Part 2 — Unit position and the tag/rewrite guards

**Goal.** A pure core that knows the current unit and the finished units, and the guards that reject a skip-ahead tag, a move with an undelivered job, and rewrites that change finished units or move taught nodes past the current unit.

**Files.**
- New `src/core/units.ts`.
- `src/core/native-messages.ts`: add `"lesson-record"` and `"units-note"` to the `LhMarkerMessage.customType` union; add both to the "neutral" list at the classifier (`["graph-context", "plan-block", …]`, ~l.991).
- `src/core/contracts/chat.ts`: `LessonRecordDetails` type (below) and `LESSON_RECORD_HEADER`.
- `src/agent/tools.ts`: `nodeIdProblem` → `teachTagProblem` (quiz ~l.234 and explain ~l.386 call sites).
- `src/agent/plugin-question-tools.ts` and `src/agent/teacher-agent.ts` (~l.357): the plugin teach-question check uses the same guard (`nodeExists` becomes `tagProblem: (nodeId) => string | null`).
- `src/agent/tools/plan.ts`: rewrite guards.
- New tests: `tests/units-position.test.ts`, `tests/units-tag-guard.test.ts`, `tests/plan-init-rewrite-guard.test.ts`.

**Contract.**

```ts
// src/core/contracts/chat.ts
export interface LessonRecordDetails {
  firstKeptMessageId: string;   // the message carrying the first tag of the new current unit
  finishedUnitIds: string[];    // every unit before the new current unit, in order
  currentUnitId: string;        // the unit the cut moved into
  judgment: LessonJudgment;     // Part 3
  model?: string;               // provider:id of the summarizer
  tokensBefore?: number;        // provenance only
  at: string;                   // ISO time of the cut
}
```

`src/core/units.ts` (pure; all take `(tree, messages)` from the live record):

- `teachTags(messages): { nodeId, messageId, messageIndex }[]`: every teach-tagged `quiz`/`explain` call (built-in or plugin "posed" teach variant, the same selection as `derivePlanStatusesLh`), in transcript order, including calls whose nodeId no longer exists. Refactor `derivePlanStatusesLh` to use it, with identical behaviour.
- `unitIndexOf(tree, nodeId): number | null`.
- `currentUnitIndex(tree, messages): number | null`: `null` when the tree has no `units`. Otherwise the maximum `unitIndexOf` over all teach tags whose node is in the tree; `0` when no such tag exists.
- `newestLessonRecord(messages)`: the newest `lesson-record` marker whose `details.firstKeptMessageId` names an existing message, or `null`.
- `finishedUnitIds(messages): string[]`: `newestLessonRecord(...)?.details.finishedUnitIds ?? []`.
- `unitCutDue(tree, messages): boolean`: `units` exist and `currentUnitIndex > finishedUnitIds(messages).length`.

**Tag guard.** `teachTagProblem(ctx, nodeId)` runs in this order, and the first problem wins:

1. Unknown node → today's `nodeIdProblem` text, unchanged.
2. No units in the tree → `null` (no unit rules apply).
3. Let `cur = currentUnitIndex`, `target = unitIndexOf(nodeId)`.
   - `target <= cur` → `null` (current unit, or a revisit).
   - `target >= cur + 2` → **DRAFT** `nodeId "<id>" is in unit "<target title>", but the next unit is "<cur+1 title>". Units are taught in order — to skip "<cur+1 title>", rewrite the plan with plan_init first (reorder or remove it).`
   - `target === cur + 1` and any job of this chat is undelivered (`status === "running"` or `delivery?.status === "pending"`, via `jobStore.listJobs(chatId)`) → **DRAFT** `A background job (<kind>) from the current unit has not delivered yet — it still belongs to unit "<cur title>". Tell the learner it belongs to this unit and that you will wait for it; move on to "<target title>" once it has arrived.`
4. Otherwise `null`.

The quiz/explain tool ctx becomes `Pick<TeacherToolContext, "chatId" | "chatStore" | "jobStore">`. `jobStore` is already on `TeacherToolContext`.

Questions end the turn (`makeQuestionStopper`), so at most one tag lands per turn; the guard reads the persisted record only.

**Rewrite guards in `plan_init`.** These run after parsing and `createTree`, before saving, against the previous tree and the live transcript.

- Let `finished = finishedUnitIds(messages)` and `oldCur = currentUnitIndex(oldTree, messages)`.
- **Frozen units.** When `finished.length > 0`, the new tree's first `finished.length` units must have the same ids in the same order, and each must have exactly the same `nodeIds` set as in the old tree. Violation → **DRAFT** `unit "<id>" is finished (the lesson has moved past it) — finished units keep their id, order and nodes. Change only the current and later units.`
- **Taught nodes stay at or before the current unit.** This applies to every rewrite, including the first grouping of a unit-less plan.
  - Let `latest` be the most recent teach tag whose node exists in the new tree. If there is none, the guard passes.
  - `limit = unitIndexOf(newTree, latest.nodeId)`. Every node id with any teach tag that exists in the new tree must have `unitIndexOf <= limit`.
  - Violation → **DRAFT** `node "<id>" has already been taught but would sit in unit "<u>", after the current unit "<limit title>". Keep taught nodes in the current unit or earlier.`
- A new tree without units, when the old tree had units and `finished.length > 0` → the frozen-units problem.

**Edge cases to test.**
- A revisit tag into unit 0 while the current unit is 2 → allowed, and `currentUnitIndex` stays 2.
- A tag into the next unit with a `running` job → rejected; with a `done` + `delivered` job → allowed; with no jobs → allowed.
- A tag two units ahead → rejected even when no job is pending.
- A conversion rewrite that puts taught nodes in units 0–1 with the latest tag in unit 1 → ok; one that puts a taught node in unit 2 → rejected.
- With a record marker (`finishedUnitIds: ["basics"]`) present: a rewrite that renames `basics`, moves a node out of it, or reorders it → rejected; one that splits the current unit → ok.
- A tree without units → every guard returns no problem, and `unitCutDue` is false.

---

## Part 3 — The lesson record (pure core)

**Goal.** Compute the record's facts from the transcript, build the summarizer prompt, validate and merge its JSON, and render the record text.

**Files.**
- New `src/core/lesson-record.ts`.
- `src/core/contracts/chat.ts`: `LessonJudgment`, caps.
- New tests: `tests/lesson-record-facts.test.ts`, `tests/lesson-record-judgment.test.ts`, `tests/lesson-record-render.test.ts`.

**Contract and constants.**

```ts
export interface NodeJudgment { learned: string; errorsCorrected: string; openPoints: string }
export interface LessonJudgment {
  learnerWide: string;
  commitments: string;                 // "" when none
  nodes: Record<string, NodeJudgment>; // keyed by node id; keeps ids that later leave the plan
}
export const LESSON_RECORD_CAPS = { learned: 400, errorsCorrected: 300, openPoints: 300, learnerWide: 1500, commitments: 600 } as const;
export const CHECK_STEM_CLIP = 120;     // characters, then "…"
export const EXPLAIN_ANSWER_CLIP = 160; // characters, then "…"
export const LESSON_RECORD_HEADER = "[LESSON RECORD] The lesson before this point was taught in earlier units; this record replaces that transcript. Its progress facts are computed by the app and are authoritative. Everything after this message is the verbatim transcript of the current unit."; // DRAFT
```

**Check lines** (`checkLines(messages): Map<nodeId, string[]>`): one line per **answered** built-in teach `quiz`/`explain` call with a `nodeId`, in transcript order. "Answered" means a matching `toolResult` exists, is not `isError`, and has object `details` (`QuestionAnswerData`). A line is `<role> — "<stem>" — <outcome>`:

- role: the call input's `type` (`predict` | `check`); `check` when absent.
- stem: `details.questionText`, whitespace-collapsed and clipped to `CHECK_STEM_CLIP`.
- outcome:
  - `dismissed: true` → `skipped`
  - else `dontKnow: true` → `didn't know`
  - else quiz with `correct === true` → `right`
  - else quiz with `correct === false` → `wrong (picked "<label>", "<label>")` from `details.answers[].label`
  - else explain → `own words, ungraded: "<text clipped to EXPLAIN_ANSWER_CLIP>"`
  - otherwise → `answered`

Plugin questions produce no line (spec choice 4).

**Facts** (`recordFacts(tree, messages, finishedUnitIds, currentUnitId)`):

- **Plan**, unit by unit in order: `Unit <n> · <title> (finished|current|upcoming)`, then ` — source: <source>` if present. Under it, each node: `- [<status>] <title> (<id>)` with status from `derivePlanStatusesLh` over the full transcript, then its check lines indented `    · <line>`. Then one line `Requires: a → b, c → d` (all edges). A tree without units renders the nodes flat under `Plan` (only reachable when a record exists, which needs units; keep it defensive).
- **Taught, no longer in the plan**: nodes with check lines or judgment whose id is not in the tree, as `- (<id>)` plus check lines. The section is omitted when empty.
- **Probe assessment**: from the first successful `probe_done` (`probeDoneResultIds` + `parseProbeDoneInput`), as `- <strand>: <assessment>` per strand, plus `Summary: <summary>` if present. Omitted when absent.
- **Current position**: `Current unit: Unit <n> · <title>`, plus `current node: <title> (<id>)` when one exists.

**Summarizer prompt** (`buildLessonRecordPrompt(input)`), **DRAFT** wording:

> You are writing the judgment part of a lesson record: the notes your future self will teach from INSTEAD of the transcript below, which is being cut away. Progress facts (plan, statuses, check outcomes) are computed separately and are not your job — never state what was taught or how far the lesson got.
>
> Write about the learner, from the transcript only. Every claim must be traceable to what he said or answered.
>
> Return ONE JSON object and nothing else:
> {"learnerWide": string, "commitments": string, "nodes": [{"nodeId": string, "learned": string, "errorsCorrected": string, "openPoints": string}]}
>
> - nodes: exactly one entry for each of these node ids, which were taught in this stretch: <ids>. No other ids. `learned` (≤400 chars, required): what he now understands and how he showed it. `errorsCorrected` (≤300, "" if none): misconceptions that surfaced and were corrected. `openPoints` (≤300, "" if none): what is still shaky or unresolved. Where a previous entry exists (below), rewrite it to include what this stretch changed.
> - learnerWide (≤1,500 chars): only what shows across nodes — his stated or observed preferences (pace, formality, examples vs derivations), recurring misconceptions or reasoning habits, how his goal has evolved. Do not restate the probe assessment. Rewrite the previous text (below) to include this stretch.
> - commitments (≤600 chars, "" if none): promises the tutor made that are still owed (e.g. "come back to the Bode plot after unit 3"), each naming its node id when it has one. Keep earlier commitments still owed; drop those fulfilled.

The prompt is followed by: the computed facts text; the previous judgment (`learnerWide`, `commitments`, and the previous entries for the listed ids); then `TRANSCRIPT:` and the span text from `serializeForSummary`.

**Validation** (`parseLessonJudgment(text, taughtIds): { ok: true; value } | { ok: false; problems: string[] }`):
- Strip one surrounding code fence (```` ``` ```` or ```` ```json ````), then `JSON.parse`. A parse failure → `not valid JSON: <message>`.
- Shape: the fields above and their types.
- `nodes` ids must equal the `taughtIds` set: missing → `missing entry for node "<id>"`; extra → `node "<id>" was not taught in this stretch`; duplicate → `node "<id>" appears twice`.
- `learned` must be non-empty after trimming.
- Each string field must be `<=` its cap after trimming → `<field> of "<id>" is <n> characters; the limit is <cap>` (or `learnerWide is …` / `commitments is …`).
- Values are never truncated.

**Merge** (`mergeJudgment(previous, parsed)`): `learnerWide` and `commitments` come from the parsed JSON. `nodes` = the previous nodes with each parsed entry replacing or adding its id. Every other previous entry is copied unchanged, including ids no longer in the plan.

**Render** (`renderLessonRecord(facts, judgment)`), the marker content:

```
[LESSON RECORD header]

## Plan
…facts…
## Taught, no longer in the plan        (only if non-empty; judgment entries for these ids render here too)
## Probe assessment                      (only if present)
## Current position
## The learner, per node
### <title> (<id>)                       (every node with a judgment entry, in plan order; orphans after)
Learned: …
Errors corrected: …                      (line omitted when "")
Open points: …                           (line omitted when "")
## Across the lesson
<learnerWide>
## Commitments still owed
<commitments, or "none">
```

**Tests.**
- A transcript with 3 tagged quizzes (right; wrong with two picks; dismissed), 1 explain, 1 don't-know and 1 unanswered call → exact check lines; the unanswered call has none.
- A stem of 130 characters is clipped to 120 + "…".
- Facts for a two-unit tree: statuses and the current position.
- `parseLessonJudgment` accepts a fenced valid object and rejects each listed problem with its exact text.
- `mergeJudgment` keeps an untouched entry byte-for-byte and keeps an orphan id.
- Rendering omits empty sections and lines.

---

## Part 4 — Two cut kinds: projection, accounting and compaction scope

**Goal.** Everything that today honours "the newest compaction marker" understands the lesson-record marker. In-unit compaction never crosses a unit cut and drops its plan section once a record exists. Records are inserted by hand in this part's tests; the runner comes in Part 5.

**Files.**
- `src/core/compaction.ts`:
  - add `isContextCut(m)` (compaction or lesson-record);
  - use it in `lastAssistantUsageIndex` (~l.158), the non-candidate list (~l.217), and the walk-back stops in `compactionCutIndex` / `compactionCutPoints` (~l.263, ~l.281);
  - `buildCompactionPrompt` gains `afterRecord: boolean`.
- `src/core/native-messages.ts`: `toLlmMessages` (~l.654–705) and `cliContextWindowOf` (~l.120).
- `src/core/context-usage.ts`: `measuredContextTokens` (~l.15).
- `src/core/side-chat.ts`: `sideChatLessonDocument` (~l.446).
- `src/core/input-events.ts`: `failedResponseAtEnd` (~l.402) skips `lesson-record` and `units-note` markers.
- `src/server/side-context-budget.ts` (~l.39): accept appended `lesson-record` markers like compaction markers.
- `src/server/compaction.ts`: the span start and the plan-section rule in `compactPass` (~l.261–295).
- New tests: `tests/unit-cut-projection.test.ts`, `tests/unit-cut-accounting.test.ts`, `tests/unit-cut-compaction-scope.test.ts`.

**Rules.**

1. **Projection.** Let `R = newestLessonRecord(messages)` with kept index `r`, and `C = activeCompactionOf(messages)` with kept index `c`.
   - No `R` → exactly today's behaviour.
   - `R` and (`C` absent, or `c < r`, or `c` missing) → heads `[R.content]`, start `r`.
   - `R` and `c >= r` → heads `[R.content, C.content]` in that order, start `c`.
   - Every `compaction` and `lesson-record` marker in the retained range is skipped. A record whose kept id is missing is ignored (falls through to the compaction-only rule).
2. **Usage anchor / meter / CLI window.** `lastAssistantUsageIndex`, `measuredContextTokens` and `cliContextWindowOf` stop at either marker kind.
3. **Compaction never crosses a unit cut.** When `R` exists:
   - the compaction span starts at `max(r, previous compaction kept index if that index >= r)`;
   - a previous compaction summary is passed as `priorSummary` only when its kept index `>= r`;
   - cut candidates are `> r`; if none exists, compaction does nothing.
4. **Compaction prompt after a record** (`afterRecord: true`): omit the "plan dependency tree" section entirely, and scope the remaining three sections to "the current unit". **DRAFT** section intros: "## The learner's understanding (this unit)", "## The teaching arc (this unit)", "## The current moment". Before any record (`afterRecord: false`) the prompt is unchanged byte-for-byte.
5. **Side helper.** The lesson document starts at the newest cut of either kind (the later kept index of `R` and `C`), with the same "Earlier history is omitted…" block. The record content is never included.

**Tests.**
- Projection: a record only; a record then an in-unit compaction; an older compaction (before the record) ignored; a record with a missing kept id falls back.
- Usage anchor: an assistant usage before a record marker is not used.
- `compactionCutIndex` never returns an index `<= r`.
- `buildCompactionPrompt({afterRecord:false})` still contains `## The plan dependency tree` and the plan text. `afterRecord:true` contains neither, and contains `(this unit)`. Existing compaction tests pass unchanged.
- The side lesson document after a record starts at `r`.

---

## Part 5 — The unit-cut runner

**Goal.** After the turn that first tags the next unit, the cut runs in the background; the next turn's gate waits for it or runs it. A failed cut leaves the record untouched and is retried after the next turn.

**Files.**
- `src/server/compaction.ts`: the registry runs `maintain(deps, chatId)` = unit cut if due, then compaction passes as today. `kickCompaction`/`ensureCompacted` trigger when `unitCutDue || overThreshold`.
- New `src/server/unit-cut.ts`: `runUnitCut(deps, chatId): Promise<"done" | "failed" | "skipped">`.
- `src/server/chat-handler.ts`: deps wiring at both call sites (~l.389 gate, ~l.931 settle kick). No new gate: the existing one now covers unit cuts.
- `app/api/chats/route.ts` (~l.17): unchanged field; `compacting` stays true while either step runs.
- New tests: `tests/unit-cut-runner.test.ts` (inject the summarizer and an in-memory chat store written in the test file).

**`runUnitCut` rules.**

1. `isTurnRunning(chatId)` → `"skipped"`. Read the record fresh; no tree, or `!unitCutDue` → `"skipped"`.
2. `cur = currentUnitIndex`; `finished = tree.units.slice(0, cur).map(u => u.id)`; `currentUnitId = tree.units[cur].id`.
3. **Boundary.** `firstKept` is the message of the earliest teach tag whose node is in unit `cur`. Span start `s` = the previous record's kept index, or `0`. Span = `messages[s, k)`, where `k` = index of `firstKept`.
4. `taughtIds` = distinct node ids of teach tags inside the span (orphans included).
5. Prompt input:
   - raw `serializeForSummary(span minus compaction/lesson-record/units-note markers)`;
   - if it doesn't fit (spec choice 3), use the newest compaction marker inside the span with kept index `c` (`s < c < k`): its summary + `serializeForSummary(messages[c, k))`;
   - if neither fits, log `unit cut skipped — the finished unit does not fit one summary request` → `"failed"`.
6. Call the summarizer (`deps.summarize ?? subagentSummarizer`, the session's engine) and parse with `parseLessonJudgment`. On problems, call once more with the prompt plus **DRAFT** `\n\nYour previous answer was rejected:\n- <problem>\n…\nReturn the corrected JSON object only.` Still invalid, or a throw → log and return `"failed"` (record untouched).
7. Build `judgment = mergeJudgment(previousRecord?.details.judgment ?? empty, parsed)`, facts and content.
8. Re-read the record. Insert the marker at the old end index, the same seam as `compactPass` (#518), with `details = { firstKeptMessageId, finishedUnitIds: finished, currentUnitId, judgment, model, tokensBefore, at }`.
9. Record usage with `appendTurnUsage` keyed to the marker id, as compaction does. Emit `record-changed`.
10. Running state: emit `compaction-changed` with `{ chatId, running: true, unit: cur + 1 }` before the summarizer call and `{ chatId, running: false }` after, whatever the outcome.

**`maintain` order.** First `runUnitCut` (any outcome), then the existing compaction loop if the projection is still over threshold. A failed unit cut therefore falls back to compaction inside the old unit. Under `NODE_ENV=test` without an injected summarizer, `ensureCompacted` stays a no-op as today.

**Tests.**
- A due cut writes one marker with the right `firstKeptMessageId`, `finishedUnitIds` and `currentUnitId`, and the projection now starts at that message.
- A first invalid then valid JSON answer → one retry, then success.
- Two invalid answers → no marker, and `"failed"`.
- A conversion-style record where the current unit is 2 → `finishedUnitIds` has 2 ids.
- A raw span too large for an injected `summaryRequestFits` → the compaction-summary fallback is used.
- Not due → no summarizer call.
- The running event carries `unit`.

---

## Part 6 — Converting old lessons (one-time note)

**Goal.** A teaching lesson whose plan has no units gets one note asking the teacher to group it.

**Files.**
- `src/core/native-messages.ts`: `newUnitsNoteMessage()`.
- `src/server/chat-handler.ts`: append the note in the same write-ahead as the turn's input (`inputAppends`, ~l.555/610) when all of these hold:
  - kind is teach;
  - `hasProbeDone(messages)`;
  - the tree exists with ≥1 node and no `units`;
  - no `units-note` marker exists in the transcript;
  - the input is learner/automatic input of a teaching turn (not side-question-only or retry).
- `src/core/view.ts` (`projectMarker`, ~l.410): a `units-note` marker renders nothing.
- New tests: `tests/units-note.test.ts`.

**Note text, DRAFT** (it arrives on the user-role wire, so it uses the bracket convention like `[Session context]`):

> [Session note] This lesson's plan has no units yet. If it spans more than one topic, re-call plan_init now with the same nodes grouped into ordered units (`subgraph slug[Title]` … `end`, optional `%% source:` line). Already-taught nodes must sit in the current unit or earlier. A single-topic plan may stay as it is. Then continue teaching where you left off; don't present the plan again.

**Tests.** The note is appended exactly once across two turns; not for a lesson with units, a lesson without a plan, or before `probe_done`; the view renders nothing for it; `toLlmMessages` carries it as a user message.

---

## Part 7 — Teacher doctrine (prompts)

**Goal.** The teacher plans units, presents them, moves between them, and waits for jobs. Run with `--no-tests-first` if the ladder can't test prose; the one test below is enough.

**Files.**
- `src/agent/prompts/teacher/10-planning.md`.
- `src/agent/prompts/teacher/40-jobs.md`.
- New test: `tests/prompt-units-doctrine.test.ts` asserts that `composeInstructions("teacher")` contains `subgraph`, `%% source:` and `unit`, and that the prober prompt does not mention units.

**DRAFT additions** (owner edits wording before this part runs):

- In "## The plan map", after the mermaid paragraph:
  > **Units.** Group the map into ordered units with flat subgraphs (`subgraph slug[Title]` … `end`). A unit is one coherent topic, usually a chapter or section of his material, cut where that material is closed, and roughly 3–5 nodes. Every node sits in exactly one unit, and a prerequisite never sits in a later unit. If his material has a place for the unit, add `%% source: <chapter, pages>` inside it. A short single-topic lesson needs no units. When you move into the next unit, the conversation continues from a lesson record instead of the full transcript, so finish a unit's open threads before moving on.
- In "## Presenting the plan", item 1:
  > Name the units in order, one clause each, and say in one sentence that each unit continues from a summary of the lesson so far rather than the whole conversation.
- In "## The map moves with him":
  > Units you have moved past are fixed: a rewrite keeps their ids, order and nodes. Restructure only the current and later units; a newly discovered foundation goes into the current unit. Revisiting a node from an earlier unit is fine and stays in the current unit. You can only move into the next unit, never skip one; to skip, rewrite the plan first.
- In `40-jobs.md`, after rule 3:
  > A job belongs to the unit you dispatched it in. Before moving into the next unit, wait until every job has delivered: tell him it belongs to this unit and that you'll wait for it.

---

## Part 8 — What the learner sees

**Goal.** A unit divider in the transcript, unit boxes on the plan, the running-state wording. The lesson record is never rendered.

**Files.**
- `src/core/view.ts`:
  - in the fold (~l.185), before each message whose id is some lesson-record marker's `firstKeptMessageId` (every record, not only the newest), emit `{ id: "unit_<markerId>", role: "user", parts: [{ type: "data-unit-cut", id: "uc_<markerId>", data: { unitIndex, title } }] }`, where `unitIndex` is the 1-based position of `details.currentUnitId` in the live tree's units, or `finishedUnitIds.length + 1` if the id is gone, and `title` is the unit's title or the id;
  - `projectMarker`: `lesson-record` renders nothing (no moment note).
- `components/compaction-divider.tsx`: `UnitCutDivider`, with the same geometry as `CompactionCutDivider`, label `Unit <n> · <title>`, inert, `data-testid="unit-cut-divider"`.
- `components/chat.tsx` (~l.1789): render `data-unit-cut`.
- `components/chat.tsx` (~l.1994) and the `compaction-changed` handler (~l.1530): while running with `unit`, show `SUMMARIZING UNIT <n>…` (spinner label `Summarizing unit <n>`) instead of `COMPACTING CONTEXT…`.
- `components/sidebar.tsx` (~l.284): `Summarizing unit · <timeAgo>` while a unit cut runs. `app/api/chats/route.ts` adds `compactingUnit?: number` from the registry, so `src/server/compaction.ts` exposes `runningUnit(chatId): number | undefined`.
- `components/plan-block.tsx`:
  - `blockLayout` uses a compound dagre graph when the tree has units: one cluster per unit (`setParent`), drawn as a rounded box with the unit title top-left;
  - no units → today's layout, unchanged;
  - neighborhood blocks are unchanged.
- `src/core/plan-blocks.ts` and `PlanBlockData` (`src/core/contracts/chat.ts` ~l.277): the full-block snapshot carries `units` (from the tree) unchanged; frozen snapshots never recompute.
- `PlanPopup` (live overlay): computes `finished = finishedUnitIds(messages)` and `current = currentUnitIndex`. Finished unit boxes and their nodes render muted (reduced opacity token); the current unit's box gets the emphasis stroke.
- New tests: `tests/unit-cut-view.test.ts`, `tests/render-unit-cut-divider.test.tsx`, `tests/plan-block-units.test.tsx`.

**Tests.**
- The view emits a divider at each record's kept message, with the right number and title, and nothing at the record marker itself.
- The divider renders its label and has no button.
- A unit tree layout produces one cluster per unit containing exactly its nodes; a unit-less tree's layout is identical to today's (compare with `blockLayout` output in the same test before and after units are stripped).
- The live overlay marks finished units muted.

---

## Part 9 — Docs

`--no-tests-first`.

**Files.**
- `docs/compaction-accounting.md`: the two cut kinds, the projection order, usage-anchor resets, and that compaction never crosses a unit cut.
- `docs/architecture.md`: the units / lesson-record / unit-cut flow (one section), pointing to `CONTEXT.md` and this plan.
- `docs/teaching-methodology.md`: one paragraph on units and moving between them.

---

## Status per part

| Part | Status | Build id |
|---|---|---|
| 1 Units in the plan map | not started | |
| 2 Unit position and guards | not started | |
| 3 Lesson record core | not started | |
| 4 Two cut kinds | not started | |
| 5 Unit-cut runner | not started | |
| 6 Conversion note | not started | |
| 7 Teacher doctrine | not started | |
| 8 What the learner sees | not started | |
| 9 Docs | not started | |
