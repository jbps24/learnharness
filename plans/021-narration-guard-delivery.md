# 021 — Grading hidden as narration: the guard recovers the content, not just a message

Status: **approved** 2026-11-25.

## Starting a session on this plan

1. Until this line says **approved**, do not run any part.
2. Run the parts in order through the ladder (`execute-plan` skill), each in the form written under its heading: `ladder queue --plan plans/021-narration-guard-delivery.md --step "Part 1" --step "Part 2" --step "Part 3"`. Build and install follow after asking (not a ladder part).
3. Rules: tests first and locked; new test files and helpers only; existing tests keep passing unchanged. Texts marked **confirmed** are used verbatim.

## What this fixes

On `claude-code` / Sonnet, the teacher sometimes writes its grading of the learner's answer as plain prose before the next question. The API turns that prose into a hidden thinking block with a `narration` signature (`src/agent/claude-code/stream.ts`, `signatureDelta`). The narration guard (`src/agent/narration-guard.ts`) catches this and blocks the question once. Its rejection asks the model to "write the explanation … through `send_to_user`, then retry this question". The model often answers with a one-line bridge and reposts the same question. The grading never reaches the learner.

Evidence, `chat_mvvbllhn_781793fa` (SpeechSignalProcessing), 2026-11-25 (local time):

| Blocked at | Narration (hidden) | Forced `send_to_user` | Same question reposted |
|---|---|---|---|
| 16:01 | 250 chars, grading of a 3-part answer | 976 chars, full grading | yes |
| 16:13 | 268 chars, grading plus "I'll move on to the units point" | 174 chars, "It uses the recap above …" | yes |
| 16:16 | 232 chars, grading of a 2-part answer | 163 chars, "The recap for the next question is …" | yes |
| 16:24 | 263 chars, grading of the x/y=x² answer | 121 chars, "The check ties this to Ch. 7 …" | yes (reworded) |

The turn at 16:20 went straight to `send_to_user` and was graded correctly. Three consecutive learner answers lost their grading.

**Root cause.**
1. The rejection does not tell the model that the learner saw **nothing** of its prose. Twice the recovery refers to a "recap" that exists only in the hidden narration. The model treats its own prose as delivered and sends a bridge.
2. The guard credits **any** successful `send_to_user` as delivery. Worse, the forced `send_to_user` and the reposted question arrive as **separate assistant messages** (16:13: narration+question in message 567, `send_to_user` in 569, question in 571). The guard's check is per message, and message 571 has no narration block, so it passes without any check.
3. The same held CLI process served all four turns (no `reuse rejected` log line after 15:08Z). Each failed turn stays in that process's context as an example to copy. A fresh-process replay drops thinking blocks (`src/agent/claude-code/transcript.ts`), so the grading is also lost from the tutor's memory there.

## Owner decisions (2026-11-25)

1. **Rejection wording:** say plainly that the learner saw none of the text, and quote the hidden narration back to the model.
2. **Delivery check:** block the question again when the `send_to_user` text delivered is shorter than the hidden narration text. The block budget (`NARRATION_GUARD_MAX_BLOCKS = 2` per run) still caps it.
3. **Fallback:** when the budget is spent and the content is still owed, the question goes through, and the learner sees the hidden narration above it under a marker.
4. **Prompt rule:** "grading first" in the Claude-only delivery rule. No rule for requests inside answers.
5. **Units** (the original report: manual unit change, review pass after the last unit): a separate plan later. Out of scope here.

## Texts (**confirmed** 2026-11-25)

- **`narrationBlockReason(narration)`** replaces the constant `NARRATION_BLOCK_REASON`. With non-empty narration:
  > The learner has not seen any of the text you wrote in this response. It was turned into hidden thinking. Your hidden text: «<narration>». Send that content in full through `send_to_user`: the grading of the learner's answer, corrections, and a reply to anything the learner asked. Then pose the question again.

  With empty narration (the narration block's text is empty), the sentence `Your hidden text: «…».` is left out.
- **Grading-first rule**, appended to `SEND_TO_USER_DELIVERY_RULE`:
  > When the learner has answered a question, your first call is `send_to_user` with your grading of that answer: what was right, what was wrong, and why. Only then pose the next question.
- **Fallback marker** (view label above the shown narration): `Tutor's notes (not sent as a message)`

## Spec-level choices (approved with this plan)

- **Narration text** of a message: the `thinking` text of its narration blocks (`isNarrationBlock`), joined with a blank line and trimmed. No length cap (observed 232–268 chars).
- **Owed narration** (Part 2): the guard keeps, per run, the narration text of the most recent blocked message (`owed`) and the `send_to_user` text length delivered since that block (`deliveredSince`, the sum of `sendToUserText(...).trim().length` over successful calls). A question call is blocked when `owed` is set and `deliveredSince < owed.length`, within the budget, with `narrationBlockReason(owed)`. A delivery that reaches `owed.length` clears `owed`. The existing same-message rule (narration and no delivered prose in the message carrying the question) stays, and it now also uses the length rule: delivered text in that same message shorter than its narration counts as not delivered.
- **Shared rule** in `src/core` (new `src/core/narration-debt.ts`): a pure function over the persisted messages that finds, for each stored guard rejection (a `toolResult` whose text starts with the new reason's first sentence **or** the old `NARRATION_BLOCK_REASON`), the narration of the blocked message, and whether the `send_to_user` text after it, up to the next question call that was not rejected, is shorter. The guard (Part 2) and the view (Part 3) use the same length rule.
- **Fallback is derived, not stored** (Part 3): the view shows the owed narration above the question that went through without enough delivery. Nothing new is persisted, the model context is unchanged, and stored chats get it retroactively. In this chat the three lost gradings of 16:13, 16:16 and 16:24 appear; 16:01 does not (enough was delivered).

## Part 1 — Rejection text and grading-first rule

Form: light

**Files.** `src/agent/narration-guard.ts` (`narrationBlockReason`, narration-text helper, `SEND_TO_USER_DELIVERY_RULE`).

**Tests** (new `tests/narration-guard-reason.test.ts`; fixtures copied from the stored messages 565–571 into the test file):
- The reason for the 16:13 message contains the confirmed text with that message's narration quoted.
- A narration block with empty text gives the reason without the quote sentence.
- `SEND_TO_USER_DELIVERY_RULE` ends with the confirmed grading-first rule.
- The guard blocks with the new reason.

## Part 2 — Delivery check across messages

Form: full

**Files.** New `src/core/narration-debt.ts` (length rule, used by guard and view). `src/agent/narration-guard.ts` (`owed` / `deliveredSince` state in `makeNarrationGuard`).

**Tests** (new `tests/narration-guard-delivery.test.ts`, `tests/narration-debt.test.ts`; fixtures from the four stored cases):
- 16:13, 16:16, 16:24 replayed through the guard: after the short bridge, the reposted question is blocked again.
- 16:01: the full grading clears the debt, and the reposted question passes.
- Budget: after two blocks, the question passes.
- A turn with no narration is never blocked; a question in the same message after a long enough `send_to_user` passes.
- `narration-debt`: on the stored 16:13 sequence it reports the owed narration before message 571; on 16:01 it reports none; an old-wording rejection is recognized.

## Part 3 — Fallback: show owed narration in the view

Form: full

**Files.** `src/core/view.ts` (a part carrying the owed narration before the question part), the chat component that renders it (`components/…`, the one rendering view parts), `docs/architecture.md` (guard, debt rule, fallback; docs live in this last code part).

**Tests** (new `tests/narration-fallback-view.test.ts`): the view of the 16:13 sequence has the owed-narration part with the marker label before the question at 571; 16:01 has none; a chat without guard rejections renders unchanged.

## Last stage — build and install (after the parts, not a ladder part)

`desktop:dist`, replace `/Applications/LearnHarness.app`, after asking.

## Status per part

- Part 1: not started
- Part 2: not started
- Part 3: not started
