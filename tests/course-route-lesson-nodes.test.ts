import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CourseMaterial } from "../src/core/contracts/course.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-route-lesson-nodes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const courseRoute = await import("../app/api/chats/[id]/course/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function routeCtx(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

async function getCourse(id: string): Promise<{
	status: number;
	body: {
		material: CourseMaterial | null;
		nodes: Array<{ id: string; title: string }>;
		lessonNodes: Array<{ lessonId: string; id: string; title: string }>;
	};
}> {
	const res = await courseRoute.GET(new Request(`http://localhost/api/chats/${id}/course`), routeCtx(id));
	return { status: res.status, body: await res.json() };
}

describe("course route lessonNodes", () => {
	// plan 009 part 1: practice record with proposition methods from two lessons gets referenced node titles ordered by first-occurrence lessonId then lesson tree node order
	it("practice record with proposition methods from two lessons returns referenced node titles in lesson-first then tree order", async () => {
		const lesson1 = chatStore.createChat("Calculus");
		chatStore.saveTree(lesson1.id, {
			nodes: [
				{ id: "n1", title: "Limits" },
				{ id: "n2", title: "Derivatives" },
				{ id: "n3", title: "Integrals" },
			],
			edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
			version: 1,
		});

		const lesson2 = chatStore.createChat("Linear Algebra");
		chatStore.saveTree(lesson2.id, {
			nodes: [
				{ id: "m1", title: "Vectors" },
				{ id: "m2", title: "Matrices" },
			],
			edges: [{ from: "m1", to: "m2" }],
			version: 1,
		});

		const practice = chatStore.createChat("Practice", "practice");
		chatStore.setCourseMaterial(practice.id, {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{ propositionId: "p1", lessonId: lesson1.id, nodeId: "n3", path: "/course/calc.pdf", method: "Integration by parts" },
				{ propositionId: "p2", lessonId: lesson2.id, nodeId: "m2", path: "/course/linalg.pdf", method: "Row reduction" },
				{ propositionId: "p3", lessonId: lesson1.id, nodeId: "n1", path: "/course/calc.pdf", method: "Epsilon-delta" },
				{ propositionId: "p4", lessonId: lesson1.id, nodeId: "n3", path: "/course/calc.pdf", method: "Substitution" },
			],
		});

		const { status, body } = await getCourse(practice.id);
		assert.equal(status, 200);
		assert.deepEqual(body.lessonNodes, [
			{ lessonId: lesson1.id, id: "n1", title: "Limits" },
			{ lessonId: lesson1.id, id: "n3", title: "Integrals" },
			{ lessonId: lesson2.id, id: "m2", title: "Matrices" },
		]);
	});

	// plan 009 part 1: deleted lesson, lesson without tree, or missing node in tree adds nothing without error while other titles are returned
	it("deleted lesson, lesson without tree, or missing node in tree adds nothing without error", async () => {
		const deletedLesson = chatStore.createChat("Deleted");
		chatStore.saveTree(deletedLesson.id, {
			nodes: [{ id: "d1", title: "Gone" }],
			edges: [],
			version: 1,
		});
		chatStore.deleteChat(deletedLesson.id);

		const treelessLesson = chatStore.createChat("No Tree");

		const validLesson = chatStore.createChat("Valid");
		chatStore.saveTree(validLesson.id, {
			nodes: [{ id: "k1", title: "Valid Node" }],
			edges: [],
			version: 1,
		});

		const practice = chatStore.createChat("Practice missing", "practice");
		chatStore.setCourseMaterial(practice.id, {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{ propositionId: "p1", lessonId: deletedLesson.id, nodeId: "d1", path: "/course/a.pdf", method: "Method A" },
				{ propositionId: "p2", lessonId: treelessLesson.id, nodeId: "t1", path: "/course/b.pdf", method: "Method B" },
				{ propositionId: "p3", lessonId: validLesson.id, nodeId: "missing-node", path: "/course/c.pdf", method: "Method C" },
				{ propositionId: "p4", lessonId: validLesson.id, nodeId: "k1", path: "/course/c.pdf", method: "Method D" },
			],
		});

		const { status, body } = await getCourse(practice.id);
		assert.equal(status, 200);
		assert.deepEqual(body.lessonNodes, [{ lessonId: validLesson.id, id: "k1", title: "Valid Node" }]);
	});

	// plan 009 part 1: lessonNodes is empty unless practice session has non-empty material.propositionMethods
	it("practice record with null courseMaterial or empty propositionMethods returns lessonNodes: []", async () => {
		const noMaterial = chatStore.createChat("Practice no material", "practice");
		const res1 = await getCourse(noMaterial.id);
		assert.equal(res1.status, 200);
		assert.deepEqual(res1.body.lessonNodes, []);

		const emptyMethods = chatStore.createChat("Practice empty methods", "practice");
		chatStore.setCourseMaterial(emptyMethods.id, {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [],
		});
		const res2 = await getCourse(emptyMethods.id);
		assert.equal(res2.status, 200);
		assert.deepEqual(res2.body.lessonNodes, []);
	});

	// plan 009 part 1: teaching record gets lessonNodes: [] and nodes is unchanged
	it("teaching record gets lessonNodes: [] and nodes is unchanged", async () => {
		const lesson = chatStore.createChat("Referenced Lesson");
		chatStore.saveTree(lesson.id, {
			nodes: [{ id: "l1", title: "Lesson Node" }],
			edges: [],
			version: 1,
		});

		const teach = chatStore.createChat("Teaching Session");
		chatStore.saveTree(teach.id, {
			nodes: [
				{ id: "t1", title: "Teach Node 1" },
				{ id: "t2", title: "Teach Node 2" },
			],
			edges: [{ from: "t1", to: "t2" }],
			version: 1,
		});
		chatStore.setCourseMaterial(teach.id, {
			files: [],
			methods: [],
			conflicts: [],
			propositionMethods: [
				{ propositionId: "p1", lessonId: lesson.id, nodeId: "l1", path: "/course/a.pdf", method: "Method" },
			],
		});

		const { status, body } = await getCourse(teach.id);
		assert.equal(status, 200);
		assert.deepEqual(body.nodes, [
			{ id: "t1", title: "Teach Node 1" },
			{ id: "t2", title: "Teach Node 2" },
		]);
		assert.deepEqual(body.lessonNodes, []);
	});
});
