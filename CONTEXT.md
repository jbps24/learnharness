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

**Retry a reply**:
The learner asks for the latest teacher reply to be written again. Only a reply to a learner input that did nothing lasting (text, read-only lookups, questions for the learner) can be retried. The old reply is kept on disk but hidden from the chat and from every model, and the turn runs again from the same input on the chat's current model.
_Avoid_: Regenerate, redo

**Node status**:
Where the teacher has been on the plan, not what the learner has mastered: upcoming, current (the teacher's most recent teaching call was about this node), or visited (the teacher has taught it and moved on).
_Avoid_: Done, mastered, completed

**Learning time**:
The time a learner has spent in a teaching lesson since the clock last reset, counted from their first activity in the lesson; probing and planning count. A gap without learner activity at least as long as the reset after inactivity is a break taken and resets it, and so does the learner ending a suggested break by choosing to continue.
_Avoid_: Session time, screen time

**Break interval**:
The learning time at which a break is due: 45 minutes unless the learner changes it. The break window opens when learning time reaches it.
_Avoid_: Break timer

**Break length**:
How long a taken break is meant to last, shown as its countdown: 10 minutes unless the learner changes it.
_Avoid_: Break duration, pause length

**Reset after inactivity**:
The gap without learner activity after which the learning clock restarts and the learner counts as away: 15 minutes unless the learner changes it. A learner-triggered answer still running counts as activity; the gap starts when it ends.

**Break window**:
The stretch of a teaching lesson in which a break is due: the app opens it when learning time reaches the break interval, and it closes when the teacher makes a break suggestion or the learning clock resets.
_Avoid_: Break timer, pause window

**Break suggestion**:
The teacher's offer of a short break, made in the next teacher turn once a break window is open, mid-node included, or at any time the learner asks for a break. It is never forced.
_Avoid_: Forced pause, break prompt

**One-more-question offer**:
A break suggestion that first offers the one question left to close the node. Skip then reads "Answer it first": the teacher poses that question, and the break window comes back with the answer to it.
_Avoid_: Last question prompt

**Closed point**:
A moment in the teaching phase where the material just taught is closed: a unit end is the last node of a unit closed, before the teacher moves into the next unit; a node end is a node's check answered correctly with no repair pending. It is no longer a break rule; breaks do not wait for it.
_Avoid_: Closed block, stopping point, breakpoint

**Find**:
Looking up a phrase in the open session, the whole of it whether shown yet or not: what the learner and teacher said, the cards (questions, answers, problems, solutions, plan) and side chats, as the learner reads them. It never finds what hasn't been revealed to the learner yet, nor the teacher's thinking.
_Avoid_: Search, session search

**Course file**:
A local file the learner attached or named, or the tutor read, that joins the session automatically. While its binding tick is on, the course methods it supplies bind the tutor.
_Avoid_: Source (that is the knowledge-graph import), attachment

**Course method**:
The route and notation a course file uses for one plan node. The tutor teaches, checks and grades by it, and gives another route only when the learner asks, labelled as not from their course.
_Avoid_: Solution method, approach

**Route conflict**:
Two course files describing different routes for one plan node. The tutor asks the learner which route their course uses, and the answer is stored on the node.
_Avoid_: Disagreement, clash

**Exam file**:
A course file that is a past exam of the course (Altklausur). It shapes practice problems; it never supplies a course method.
_Avoid_: Old exam, test file

**Exam pattern**:
What one exam task asks about one plan node: task type, givens, what is asked, answer format, typical numbers, points, its source task. When the file has a solution, also how points are given.
_Avoid_: Exam question, template

**Reference file**:
A course file the course was built from but that does not set what is learned; consulted for depth, never binding.
_Avoid_: Textbook file, background file

**Reference pointer**:
The sections of a reference file that cover one plan node.
_Avoid_: Bookmark, citation

**Complete material**:
A course material file that carries both what is taught and how (Skript, Mitschrift). The default label.
_Avoid_: Script

**Overview material**:
A course material file that carries what is taught but not how (slides). The reference file supplies the how.
_Avoid_: Slides file

**Book route**:
What one plan node's pointed reference sections add to its slide route: the derivation and the steps in between, in the slides' notation. Read once and stored.
_Avoid_: Book method, book summary

**Course-method note**:
The wire-only note that tells the tutor the course methods for a node (or the unresolved conflict). It is sent again when the node's methods change or a lesson-record cut drops it.
_Avoid_: Method hint

**Course update**:
A replaced course file's changes per plan node, kept until the tutor has handled them.
_Avoid_: Diff, changelog

**Replacement**:
A newer version of a course file taking the old one's place in the list.
_Avoid_: Re-upload, overwrite

**Learner input**:
Anything the learner contributes to a session: a typed message, an answer to a question or check, an explain-back, a practice submission, a plugin answer, or a steer.
_Avoid_: User message (only one kind of input)

**Drawn history**:
The part of an open session's history that is on the page: the newest content up to a fixed budget, starting right after a learner input, plus whatever the learner draws above it and everything that arrives while the session stays open.
_Avoid_: Loaded part, window, tail

**Earlier history**:
The part of a session's history before the drawn history: held, but not drawn until the learner reaches for it.
_Avoid_: Unloaded messages, older page
