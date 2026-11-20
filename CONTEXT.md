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
