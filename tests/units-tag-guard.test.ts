import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	ExtractionRunUsage,
	ImageSnapshot,
	JobRecord,
	PlanTree,
	SideChatThread,
	TurnUsage,
} from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore, CreateJobInit, JobPatch, JobStore } from "../src/core/ports.ts";
import { PluginQuestionLedger } from "../src/agent/plugin-question-tools.ts";
import { teachExplainToolFor, teachQuizToolFor, teachTagProblem } from "../src/agent/tools.ts";

function makeMemoryChatStore(): ChatStore {
	const chats = new Map<string, ChatRecord>();
	return {
		createChat(title, kind) {
			const id = `chat_${chats.size + 1}`;
			const now = "2026-11-20T00:00:00.000Z";
			const rec: ChatRecord = { id, title, createdAt: now, updatedAt: now, messages: [], ...(kind ? { kind } : {}) };
			chats.set(id, rec);
			return rec;
		},
		getChat: (id) => chats.get(id) ?? null,
		listChats: (): ChatSummary[] => [],
		saveMessages: (id, messages) => {
			const rec = chats.get(id);
			if (rec) rec.messages = messages;
		},
		saveImageSnapshot: (_id: string, _sid: string, _img: ImageSnapshot) => {},
		saveTree: (id, tree) => {
			const rec = chats.get(id);
			if (rec) rec.tree = tree;
		},
		appendTurnUsage: (_id: string, _entry: TurnUsage) => {},
		appendExtractionUsage: (_id: string, _entry: ExtractionRunUsage) => {},
		saveSettings: (_id: string, _settings: ChatSettings) => {},
		renameChat: (id) => chats.get(id)!,
		deleteChat: (id) => chats.delete(id),
		updateSideChats: (_id: string, _fn: (t: SideChatThread[]) => SideChatThread[]) => null,
		getCourseMaterial: () => null,
		setCourseMaterial: () => {},
	};
}

function makeMemoryJobStore(): JobStore {
	const jobs = new Map<string, JobRecord>();
	return {
		createJob(init: CreateJobInit) {
			const id = `job_${jobs.size + 1}`;
			const now = "2026-11-20T00:00:00.000Z";
			const job: JobRecord = {
				id,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				activity: init.activity ?? "starting",
				status: "running",
				createdAt: now,
				updatedAt: now,
				...(init.input !== undefined ? { input: init.input } : {}),
				...(init.plugin ? { plugin: init.plugin } : {}),
			};
			jobs.set(id, job);
			return job;
		},
		getJob: (id) => jobs.get(id) ?? null,
		updateJob(id, patch: JobPatch) {
			const job = jobs.get(id);
			if (!job) return null;
			const next = { ...job, ...patch };
			jobs.set(id, next);
			return next;
		},
		listJobs: (chatId) => [...jobs.values()].filter((j) => j.chatId === chatId),
		findJobByToolCallId: (chatId, toolCallId) =>
			[...jobs.values()].find((j) => j.chatId === chatId && j.toolCallId === toolCallId) ?? null,
		deleteJobsForChat: (chatId) => {
			let n = 0;
			for (const [id, j] of jobs) {
				if (j.chatId === chatId) {
					jobs.delete(id);
					n++;
				}
			}
			return n;
		},
	};
}

function makeQuizCallMsg(id: string, nodeId: string): LhMessage {
	const msg: AssistantMessage & { id: string } = {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: `tc_${id}`, name: "quiz", arguments: { nodeId } }],
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
		timestamp: 1,
	};
	return msg;
}

const unitTree: PlanTree = {
	nodes: [
		{ id: "n0", title: "Node 0" },
		{ id: "n1", title: "Node 1" },
		{ id: "n2", title: "Node 2" },
	],
	edges: [
		{ from: "n0", to: "n1" },
		{ from: "n1", to: "n2" },
	],
	units: [
		{ id: "u0", title: "Basics", nodeIds: ["n0"] },
		{ id: "u1", title: "Middle", nodeIds: ["n1"] },
		{ id: "u2", title: "Advanced", nodeIds: ["n2"] },
	],
	version: 1,
};

describe("teachTagProblem", () => {
	// plan 001 part 2: step 1 — unknown node returns today's nodeIdProblem text (even with a running job)
	it("returns nodeIdProblem text for unknown node or missing tree", () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc1" });

		assert.equal(
			teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n0"),
			'nodeId "n0" matches no node in this session\'s plan map. No plan map exists yet — call plan_init before posing quizzes.',
		);

		chatStore.saveTree(chat.id, unitTree);
		assert.equal(
			teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "ghost"),
			'nodeId "ghost" matches no node in this session\'s plan map. Copy one of your plan_init slugs exactly (n0, n1, n2).',
		);
	});

	// plan 001 part 2: step 2 — no units in the tree -> null (no unit rules apply)
	it("returns null when the tree has no units, even with a running job", () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, {
			nodes: [{ id: "n0", title: "N0" }, { id: "n1", title: "N1" }],
			edges: [{ from: "n0", to: "n1" }],
			version: 1,
		});
		jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc1" });

		assert.equal(teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n1"), null);
	});

	// plan 001 part 2: step 3 — revisit tag into unit 0 while current unit is 2 -> allowed (null)
	it("allows tagging the current unit or revisiting an earlier unit, even with a running job", () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, unitTree);
		chatStore.saveMessages(chat.id, [makeQuizCallMsg("m1", "n2")]);
		jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "tc1" });

		assert.equal(teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n2"), null);
		assert.equal(teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n0"), null);
	});

	// plan 001 part 2: step 3 — a tag two units ahead -> rejected even when no job is pending
	it("rejects tagging two or more units ahead with the exact skip-ahead message", () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, unitTree);

		assert.equal(
			teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n2"),
			'nodeId "n2" is in unit "Advanced", but the next unit is "Middle". Units are taught in order — to skip "Middle", rewrite the plan with plan_init first (reorder or remove it).',
		);
	});

	// plan 001 part 2: step 3 — tag into next unit with running/pending job -> rejected; done+delivered or no jobs -> allowed
	it("rejects moving to the next unit while a job is running or pending delivery, and allows when done+delivered or no jobs", () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, unitTree);

		assert.equal(teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n1"), null);

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc1" });
		assert.equal(
			teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n1"),
			'A background job (research) from the current unit has not delivered yet — it still belongs to unit "Basics". Tell the learner it belongs to this unit and that you will wait for it; move on to "Middle" once it has arrived.',
		);

		jobStore.updateJob(job.id, { status: "done", delivery: { kind: "result", status: "pending" } });
		assert.equal(
			teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n1"),
			'A background job (research) from the current unit has not delivered yet — it still belongs to unit "Basics". Tell the learner it belongs to this unit and that you will wait for it; move on to "Middle" once it has arrived.',
		);

		jobStore.updateJob(job.id, { status: "done", delivery: { kind: "result", status: "delivered" } });
		assert.equal(teachTagProblem({ chatId: chat.id, chatStore, jobStore }, "n1"), null);
	});
});

describe("quiz, explain, and plugin teach tools use teachTagProblem", () => {
	// plan 001 part 2: quiz and explain call teachTagProblem
	it("teachQuizToolFor and teachExplainToolFor reject invalid unit moves via teachTagProblem", async () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, unitTree);
		jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "tc1" });

		const quizTool = teachQuizToolFor({ chatId: chat.id, chatStore, jobStore });
		const quizRes = await quizTool.execute("c1", {
			type: "check",
			nodeId: "n2",
			question: "What is X?",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			correctAnswer: "a",
			explanation: "Because A.",
		});
		assert.equal(quizRes.isError, true);
		assert.match(
			(quizRes.content[0] as { text: string }).text,
			/nodeId "n2" is in unit "Advanced", but the next unit is "Middle"/,
		);

		const explainTool = teachExplainToolFor({ chatId: chat.id, chatStore, jobStore });
		const explainRes = await explainTool.execute("c2", {
			type: "check",
			nodeId: "n1",
			question: "Explain X.",
			correctAnswer: "X is Y.",
		});
		assert.equal(explainRes.isError, true);
		assert.match(
			(explainRes.content[0] as { text: string }).text,
			/A background job \(visual\) from the current unit has not delivered yet/,
		);
	});

	// plan 001 part 2: PluginQuestionLedger uses tagProblem: (nodeId) => string | null
	it("PluginQuestionLedger rejects teach-variant calls when tagProblem returns an error", async () => {
		const chatStore = makeMemoryChatStore();
		const jobStore = makeMemoryJobStore();
		const chat = chatStore.createChat("Test");
		chatStore.saveTree(chat.id, unitTree);

		const ledger = new PluginQuestionLedger(
			[
				{
					pluginId: "test-plugin",
					variant: "teach",
					signal: new AbortController().signal,
					requireActive() {},
					definition: {
						id: "custom",
						label: "Custom",
						contractVersion: 1,
						showThinking: false,
						questionSchema: Type.Object({ prompt: Type.String() }),
						answerSchema: Type.Object({ text: Type.String() }),
						teach: { toolName: "plugin_teach", description: "Ask custom question" },
					},
				},
			],
			chat.id,
			(nodeId) => teachTagProblem({ chatId: chat.id, chatStore, jobStore }, nodeId),
		);

		const input = { type: "check", nodeId: "n2", question: "Q?", payload: { prompt: "P" } };
		const toolCall = { type: "toolCall" as const, id: "tc_p1", name: "plugin_teach", arguments: input };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
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
			timestamp: 1,
		};
		const fakeAgent = { subscribe: () => () => {} } as never;
		ledger.bind(fakeAgent);
		// Trigger message_start / message_end epoch registration via a minimal subscriber capture
		let listener: ((e: unknown) => void) | undefined;
		ledger.bind({
			subscribe: (fn: (e: unknown) => void) => {
				listener = fn;
				return () => {};
			},
		} as never);
		listener!({ type: "message_start", message: assistantMsg });
		ledger.validatedCall({ toolCall, args: input, assistantMessage: assistantMsg } as never);

		const res = await ledger.tools[0]!.execute("tc_p1", input);
		assert.equal(res.isError, true);
		assert.match(
			(res.content[0] as { text: string }).text,
			/nodeId "n2" is in unit "Advanced", but the next unit is "Middle"/,
		);
	});
});
