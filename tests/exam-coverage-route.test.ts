import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-coverage-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const coverageRoute = await import("../app/api/practice/exam-coverage/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function assistantQuizMessage(id: string, nodeId: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `tc_${id}`,
				name: "quiz",
				arguments: { nodeId, question: "Check?" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	};
}

function userMessage(id: string, text: string): LhMessage {
	return {
		id,
		role: "user",
		content: text,
		timestamp: 1_700_000_000_000,
	};
}

describe("exam-coverage route", () => {
	// plan 010 part 4: GET /api/practice/exam-coverage returns { counts: {} } when graph is empty
	it("returns { counts: {} } when there are no propositions", async () => {
		const res = await coverageRoute.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { counts: {} });
	});

	// plan 010 part 4: Counts distinct binding exam files at nodeAtMessage in teaching lessons; omits 0
	it("counts distinct binding exam files at nodeAtMessage in teaching lessons only and omits zero counts", async () => {
		const teach = chatStore.createChat("Linear Algebra");
		chatStore.saveTree(teach.id, {
			nodes: [
				{ id: "n1", title: "Determinants" },
				{ id: "n2", title: "Eigenvalues" },
			],
			edges: [{ from: "n1", to: "n2" }],
			version: 1,
		});
		chatStore.saveMessages(teach.id, [
			userMessage("m_before", "Hi"),
			assistantQuizMessage("m_n1", "n1"),
			assistantQuizMessage("m_n2", "n2"),
		]);
		chatStore.setCourseMaterial(teach.id, {
			files: [
				{ path: "/exams/2023.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
				{ path: "/exams/2024.pdf", addedAt: "2026-11-22T10:01:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
				{ path: "/exams/unbound.pdf", addedAt: "2026-11-22T10:02:00.000Z", via: "learner", binding: false, status: "assigned", category: "exam" },
				{ path: "/course/notes.pdf", addedAt: "2026-11-22T10:03:00.000Z", via: "learner", binding: true, status: "assigned", category: "material" },
			],
			methods: [
				{ nodeId: "n1", path: "/course/notes.pdf", method: "Laplace expansion" },
			],
			conflicts: [],
			examPatterns: [
				// Two patterns in the same file for n1 -> still 1 distinct file
				{ nodeId: "n1", path: "/exams/2023.pdf", source: "Task 1a", pattern: "Compute 3x3 det" },
				{ nodeId: "n1", path: "/exams/2023.pdf", source: "Task 1b", pattern: "Compute parametric det" },
				// Second distinct binding exam file for n1
				{ nodeId: "n1", path: "/exams/2024.pdf", source: "Task 2", pattern: "Prove det(AB)=det(A)det(B)" },
				// Unbound exam file for n1 -> ignored
				{ nodeId: "n1", path: "/exams/unbound.pdf", source: "Task 3", pattern: "Unbound pattern" },
			],
		});

		// Practice session with examPatterns -> must be ignored (teaching lessons only)
		const practice = chatStore.createChat("Practice session", "practice");
		chatStore.saveTree(practice.id, {
			nodes: [{ id: "pn1", title: "Practice Node" }],
			edges: [],
			version: 1,
		});
		chatStore.saveMessages(practice.id, [assistantQuizMessage("pm1", "pn1")]);
		chatStore.setCourseMaterial(practice.id, {
			files: [
				{ path: "/exams/practice-only.pdf", addedAt: "2026-11-22T10:04:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
			],
			methods: [],
			conflicts: [],
			examPatterns: [
				{ nodeId: "pn1", path: "/exams/practice-only.pdf", source: "Task 1", pattern: "Ignored practice pattern" },
			],
		});

		graphStore.appendNode({
			id: "p_covered",
			name: "Det rule",
			statement: "Determinant is multiplicative.",
			aliases: [],
			createdAt: "2026-11-22T10:10:00.000Z",
			provenance: [{ chatId: teach.id, messageId: "m_n1" }],
		});
		graphStore.appendNode({
			id: "p_other_node",
			name: "Eigenvalues",
			statement: "Eigenvalues are roots of characteristic polynomial.",
			aliases: [],
			createdAt: "2026-11-22T10:11:00.000Z",
			provenance: [{ chatId: teach.id, messageId: "m_n2" }],
		});
		graphStore.appendNode({
			id: "p_before_tag",
			name: "Intro",
			statement: "Before any teach tag.",
			aliases: [],
			createdAt: "2026-11-22T10:12:00.000Z",
			provenance: [{ chatId: teach.id, messageId: "m_before" }],
		});
		graphStore.appendNode({
			id: "p_practice_only",
			name: "Practice prop",
			statement: "Only from practice.",
			aliases: [],
			createdAt: "2026-11-22T10:13:00.000Z",
			provenance: [{ chatId: practice.id, messageId: "pm1" }],
		});
		graphStore.appendNode({
			id: "p_notes_only",
			name: "Notes prop",
			statement: "Only from imported notes.",
			aliases: [],
			createdAt: "2026-11-22T10:14:00.000Z",
			provenance: [{ chatId: "src_notes_1", messageId: "" }],
		});

		const res = await coverageRoute.GET();
		assert.equal(res.status, 200);
		const body = (await res.json()) as { counts: Record<string, number> };
		assert.deepEqual(body, {
			counts: {
				p_covered: 2,
			},
		});
	});

	// plan 010 part 4: a proposition covered by exactly one exam file has count 1
	it("includes a proposition covered by a single exam file with count 1", async () => {
		const lesson = chatStore.createChat("Single exam");
		chatStore.saveTree(lesson.id, { nodes: [{ id: "s1", title: "Rank" }], edges: [], version: 1 });
		chatStore.saveMessages(lesson.id, [assistantQuizMessage("m_s1", "s1")]);
		chatStore.setCourseMaterial(lesson.id, {
			files: [
				{ path: "/exams/single.pdf", addedAt: "2026-11-22T10:00:00.000Z", via: "learner", binding: true, status: "assigned", category: "exam" },
			],
			methods: [],
			conflicts: [],
			examPatterns: [{ nodeId: "s1", path: "/exams/single.pdf", source: "Task 1", pattern: "Find the rank" }],
		});
		graphStore.appendNode({
			id: "p_single",
			name: "Rank",
			statement: "Rank equals column space dimension.",
			aliases: [],
			createdAt: "2026-11-22T10:20:00.000Z",
			provenance: [{ chatId: lesson.id, messageId: "m_s1" }],
		});

		const res = await coverageRoute.GET();
		const body = (await res.json()) as { counts: Record<string, number> };
		assert.equal(body.counts.p_single, 1);
	});
});
