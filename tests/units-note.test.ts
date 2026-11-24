import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	newMessageId,
	newUnitsNoteMessage,
	newUserMessage,
	newUserSteer,
	toLlmMessages,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { SubscriptionRequestCycle } from "../src/agent/subscription-request-cycle.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { PiEngine } from "../src/agent/models.ts";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-units-note-"));
process.env.LH_DATA_DIR = tmpDataDir;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");

after(() => {
	fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const EXPECTED_UNITS_NOTE_TEXT =
	"[Session note] This lesson's plan has no units yet. If it spans more than one topic, re-call plan_init now with the same nodes grouped into ordered units (`subgraph slug[Title]` … `end`, optional `%% source:` line). Already-taught nodes must sit in the current unit or earlier. A single-topic plan may stay as it is. Then continue teaching where you left off; don't present the plan again.";

const TREE_WITHOUT_UNITS: PlanTree = {
	nodes: [
		{ id: "planet-order", title: "Planet order" },
		{ id: "inner-planets", title: "Inner planets" },
	],
	edges: [{ from: "planet-order", to: "inner-planets" }],
	version: 1,
};

const TREE_WITH_UNITS: PlanTree = {
	...TREE_WITHOUT_UNITS,
	units: [{ id: "basics", title: "Basics", nodeIds: ["planet-order", "inner-planets"] }],
};

function probeDoneHistory(): LhMessage[] {
	return [
		newUserMessage("Teach me about planets."),
		{
			...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "pd_1" })], { stopReason: "toolUse" }),
			id: newMessageId(),
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: "pd_1",
			toolName: "probe_done",
			content: [{ type: "text", text: "Probe complete." }],
			details: { ok: true },
			isError: false,
			timestamp: Date.now(),
		},
	];
}

function scriptedFactory(
	responses: FauxResponseStep[],
): NonNullable<Parameters<typeof handleChatInput>[2]> {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

async function runTurn(
	chatId: string,
	input: Parameters<typeof handleChatInput>[1],
	factory: NonNullable<Parameters<typeof handleChatInput>[2]>,
	sideContext?: Parameters<typeof handleChatInput>[3],
): Promise<void> {
	const ack = await handleChatInput(chatId, input, factory, sideContext);
	assert.equal(ack.status, 200, `expected 200 ack, got ${ack.status}`);
	const handle = runningTurn(chatId);
	if (handle) {
		await new Response(handle.subscribe()).text();
	}
}

function createChat(opts: {
	title: string;
	kind?: "practice";
	tree?: PlanTree;
	messages?: LhMessage[];
}) {
	const chat = chatStore.createChat(opts.title, opts.kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	if (opts.tree) chatStore.saveTree(chat.id, opts.tree);
	if (opts.messages) chatStore.saveMessages(chat.id, opts.messages);
	return chat;
}

function unitsNoteMarkers(messages: readonly LhMessage[]) {
	return messages.filter((m) => m.role === "custom" && m.customType === "units-note");
}

describe("units-note marker and wire/view projection", () => {
	// plan 001 part 6: newUnitsNoteMessage() produces a custom units-note marker with the confirmed note text
	it("newUnitsNoteMessage returns a units-note marker with the exact confirmed text", () => {
		const note = newUnitsNoteMessage();
		assert.ok(note.id.length > 0, "note has a non-empty id");
		assert.equal(note.role, "custom");
		assert.equal(note.customType, "units-note");
		assert.equal(note.content, EXPECTED_UNITS_NOTE_TEXT);
	});

	// plan 001 part 6: toLlmMessages carries it as a user message
	it("toLlmMessages carries the units-note marker as a user message", () => {
		const note = newUnitsNoteMessage();
		const llm = toLlmMessages([note]);
		assert.equal(llm.length, 1);
		assert.equal(llm[0]!.role, "user");
		assert.deepEqual(llm[0]!.content, [{ type: "text", text: EXPECTED_UNITS_NOTE_TEXT }]);
	});

	// plan 001 part 6: view.ts projectMarker renders nothing for a units-note marker
	it("projectView renders nothing for a units-note marker", () => {
		const note = newUnitsNoteMessage();
		assert.deepEqual(projectView([note]), []);

		const assistant: LhMessage = {
			...fauxAssistantMessage([fauxText("Hello.")]),
			id: "a1",
		};
		const view = projectView([assistant, note]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.id, "a1");
	});
});

describe("units-note in SubscriptionRequestCycle.finishNativeCycle", () => {
	const scope = { accountId: "a", epoch: 1, authorityRevision: 1, selectedModelId: "m" };
	function makeCycle(history: LhMessage[], note: LhMessage) {
		const cycle = new SubscriptionRequestCycle({
			initialMessages: history as never,
			staged: [note] as never,
			foregroundOwed: false,
			purpose: { background: true },
			scopeCurrent: () => true,
			commitStaged: () => {},
			restoreAutomatic: () => {},
		});
		cycle.prepare({ context: { messages: [...history, note] } } as never);
		cycle.captured(scope);
		return cycle;
	}

	it("drops an uncommitted units-note when the wake is denied (noDispatch background)", () => {
		const note = newUnitsNoteMessage();
		const cycle = makeCycle(probeDoneHistory(), note);
		cycle.noDispatch("background");
		const outcome = cycle.finishNativeCycle();
		assert.ok(!outcome.messages.some((m) => (m as LhMessage).id === note.id));
	});

	it("drops an uncommitted units-note on a local rejection", () => {
		const note = newUnitsNoteMessage();
		const cycle = makeCycle(probeDoneHistory(), note);
		cycle.rejectLocalRequest();
		const outcome = cycle.finishNativeCycle();
		assert.ok(!outcome.messages.some((m) => (m as LhMessage).id === note.id));
	});

	it("retains units-note once beforeDispatch has committed the staged input", () => {
		const note = newUnitsNoteMessage();
		const cycle = makeCycle(probeDoneHistory(), note);
		cycle.beforeDispatch(scope);
		cycle.rejectLocalRequest();
		const outcome = cycle.finishNativeCycle();
		assert.ok(outcome.messages.some((m) => (m as LhMessage).id === note.id));
	});
});

describe("units-note emission in chat-handler", () => {
	// plan 001 part 6: appended once across two turns when teach + hasProbeDone + tree has >= 1 node and no units
	it("appends the note exactly once across two teaching turns", async () => {
		const chat = createChat({
			title: "Old lesson without units",
			tree: TREE_WITHOUT_UNITS,
			messages: probeDoneHistory(),
		});

		const seenPrompts: string[][] = [];
		const factory = scriptedFactory([
			(ctx) => {
				seenPrompts.push(ctx.messages.map((m) => JSON.stringify(m.content)));
				return fauxAssistantMessage([fauxText("First teaching reply.")]);
			},
			(ctx) => {
				seenPrompts.push(ctx.messages.map((m) => JSON.stringify(m.content)));
				return fauxAssistantMessage([fauxText("Second teaching reply.")]);
			},
		]);

		await runTurn(chat.id, { type: "text", text: "Let's continue." }, factory);
		const afterTurn1 = chatStore.getChat(chat.id)!;
		const notes1 = unitsNoteMarkers(afterTurn1.messages);
		assert.equal(notes1.length, 1, "note appended on first eligible teaching turn");
		assert.equal(notes1[0]!.content, EXPECTED_UNITS_NOTE_TEXT);
		assert.ok(
			seenPrompts[0]!.some((c) => c.includes(EXPECTED_UNITS_NOTE_TEXT)),
			"model receives the note on the wire in turn 1",
		);

		await runTurn(chat.id, { type: "text", text: "Keep going." }, factory);
		const afterTurn2 = chatStore.getChat(chat.id)!;
		const notes2 = unitsNoteMarkers(afterTurn2.messages);
		assert.equal(notes2.length, 1, "note is not appended a second time on turn 2");
	});

	// plan 001 part 6: not appended for a lesson with units
	it("does not append the note when the tree already has units", async () => {
		const chat = createChat({
			title: "Lesson with units",
			tree: TREE_WITH_UNITS,
			messages: probeDoneHistory(),
		});

		const factory = scriptedFactory([
			() => fauxAssistantMessage([fauxText("Teaching reply.")]),
		]);

		await runTurn(chat.id, { type: "text", text: "Let's continue." }, factory);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(unitsNoteMarkers(saved.messages).length, 0);
	});

	// plan 001 part 6: not appended for a lesson without a plan or with 0 nodes
	it("does not append the note without a tree or with an empty tree", async () => {
		const noTreeChat = createChat({
			title: "No plan",
			messages: probeDoneHistory(),
		});
		const emptyTreeChat = createChat({
			title: "Empty plan",
			tree: { nodes: [], edges: [], version: 1 },
			messages: probeDoneHistory(),
		});

		await runTurn(
			noTreeChat.id,
			{ type: "text", text: "Continue." },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Ok.")])]),
		);
		await runTurn(
			emptyTreeChat.id,
			{ type: "text", text: "Continue." },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Ok.")])]),
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(noTreeChat.id)!.messages).length, 0);
		assert.equal(unitsNoteMarkers(chatStore.getChat(emptyTreeChat.id)!.messages).length, 0);
	});

	// plan 001 part 6: not appended before probe_done
	it("does not append the note before probe_done", async () => {
		const chat = createChat({
			title: "Still probing",
			tree: TREE_WITHOUT_UNITS,
			messages: [newUserMessage("Teach me about planets.")],
		});

		await runTurn(
			chat.id,
			{ type: "text", text: "I know a little." },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Probing.")])]),
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(chat.id)!.messages).length, 0);
	});

	// plan 001 part 6: kind must be teach (not practice)
	it("does not append the note for a practice session", async () => {
		const chat = createChat({
			title: "Practice session",
			kind: "practice",
			tree: TREE_WITHOUT_UNITS,
			messages: probeDoneHistory(),
		});

		await runTurn(
			chat.id,
			{ type: "text", text: "Give me a problem." },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Here is a problem.")])]),
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(chat.id)!.messages).length, 0);
	});

	// plan 001 part 6: automatic input of a teaching turn (a steers wake) also carries the note, once
	it("appends the note once on an automatic steers wake of an eligible teaching session", async () => {
		const chat = createChat({
			title: "Wake on old lesson",
			tree: TREE_WITHOUT_UNITS,
			messages: probeDoneHistory(),
		});

		await runTurn(
			chat.id,
			{ type: "steers", steers: [newUserSteer("Heads up.", "steer_units_note_1")] },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Woken reply.")])]),
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(chat.id)!.messages).length, 1);
	});

	// plan 001 part 6: a side-question-only turn (no learner/automatic input appends) does not append the note
	it("does not append the note on a side-question-only turn", async () => {
		const history = probeDoneHistory();
		const chat = createChat({
			title: "Side question only",
			tree: TREE_WITHOUT_UNITS,
			messages: history,
		});
		const thread = {
			id: "side_anchor_1",
			anchor: { messageId: history[1]!.id, partId: `${history[1]!.id}-t0`, blockIndex: 0, blockText: "Planets." },
			open: true,
			createdAt: new Date().toISOString(),
			messages: [{ id: "sq_1", role: "user" as const, text: "What is a planet?", at: new Date().toISOString() }],
		};

		await runTurn(
			chat.id,
			{ type: "continue" },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Ok.")])]),
			{ snapshot: () => [thread] },
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(chat.id)!.messages).length, 0);
	});

	// plan 001 part 6: not appended on retry input
	it("does not append the note on a retry turn", async () => {
		const chat = createChat({
			title: "Failed turn retry",
			tree: TREE_WITHOUT_UNITS,
			messages: [
				...probeDoneHistory(),
				newUserMessage("Explain Mercury."),
				{
					...fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "Network error" }),
					id: newMessageId(),
				},
			],
		});

		await runTurn(
			chat.id,
			{ type: "retry" },
			scriptedFactory([() => fauxAssistantMessage([fauxText("Recovered reply.")])]),
		);

		assert.equal(unitsNoteMarkers(chatStore.getChat(chat.id)!.messages).length, 0);
	});
});
