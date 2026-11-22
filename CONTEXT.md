# LearnHarness

A tutoring app: a prober assesses the learner, a teacher plans a lesson as a dependency map of nodes and teaches it in one conversation.

## Language

**Unit**:
An ordered group of plan nodes covering one coherent topic, taught in one model context; the lesson's context is cut only between units. Every node belongs to exactly one unit, and a node's prerequisites lie in its own unit or an earlier one. A plan without grouping is a single unit.
_Avoid_: Part, chapter, stage, phase

**Current unit**:
The furthest unit the teacher has moved into so far. It only advances; returning to a node of an earlier unit is a revisit inside the current unit.

**Unit cut**:
The point where the lesson's model context is replaced by the lesson record, made automatically right after the teacher first moves into the next unit. The move itself (its opening question and the learner's answer) is kept verbatim in the new unit.
_Avoid_: Part cut, reset

**Lesson record**:
The durable account of a lesson so far, carried into each new unit of the lesson in place of the earlier transcript. Its progress facts (plan with units, node statuses, check outcomes, probe assessment, current position) come from the transcript itself; only its judgment of the learner (what was learned per node, misconceptions, open points, learner-wide traits) is written by a model.
_Avoid_: Course record, compaction summary, ChatRecord

**Compaction summary**:
A model-written summary that stands in for the older stretch of the current unit when its context grows too large. It never rewrites the lesson record.
_Avoid_: Lesson record

**Node status**:
Where the teacher has been on the plan, not what the learner has mastered: upcoming, current (the teacher's most recent teaching call was about this node), or visited (the teacher has taught it and moved on).
_Avoid_: Done, mastered, completed

**Learning time**:
The time a learner has spent in a teaching lesson since the clock last reset, counted from their first activity in the lesson; probing and planning count. A gap without learner activity at least as long as the reset after inactivity is a break taken and resets it, and so does the learner ending a suggested break by choosing to continue.
_Avoid_: Session time, screen time

**Break interval**:
The learning time around which a break is aimed: 45 minutes unless the learner changes it. The break window opens shortly before it, so breaks land around it rather than always after.
_Avoid_: Break timer

**Break length**:
How long a taken break is meant to last, shown as its countdown: 10 minutes unless the learner changes it.
_Avoid_: Break duration, pause length

**Reset after inactivity**:
The gap without learner activity after which the learning clock restarts and the learner counts as away: 15 minutes unless the learner changes it. A learner-triggered answer still running counts as activity; the gap starts when it ends.

**Break window**:
The stretch of a teaching lesson in which a break is due: the app opens it shortly before learning time reaches the break interval, and it closes when the teacher makes a break suggestion or the learning clock resets.
_Avoid_: Break timer, pause window

**Break suggestion**:
The teacher's offer of a short break, made at a closed point it picks inside a break window, or at any time the learner asks for a break. It is never forced.
_Avoid_: Forced pause, break prompt

**Closed point**:
A moment in the teaching phase where the material just taught is closed, so a break doesn't split it. A unit end is the last node of a unit closed, before the teacher moves into the next unit; a node end is a node's check answered correctly with no repair pending, before the teacher moves on. A unit end is preferred; never mid-step or during a repair.
_Avoid_: Closed block, stopping point, breakpoint

**Find**:
Looking up a phrase in the open session, the whole of it whether shown yet or not: what the learner and teacher said, the cards (questions, answers, problems, solutions, plan) and side chats, as the learner reads them. It never finds what hasn't been revealed to the learner yet, nor the teacher's thinking.
_Avoid_: Search, session search

**Learner input**:
Anything the learner contributes to a session: a typed message, an answer to a question or check, an explain-back, a practice submission, a plugin answer, or a steer.
_Avoid_: User message (only one kind of input)

**Drawn history**:
The part of an open session's history that is on the page: the newest content up to a fixed budget, starting right after a learner input, plus whatever the learner draws above it and everything that arrives while the session stays open.
_Avoid_: Loaded part, window, tail

**Earlier history**:
The part of a session's history before the drawn history: held, but not drawn until the learner reaches for it.
_Avoid_: Unloaded messages, older page
