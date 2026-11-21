import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, PlanToolResult, PlanTree } from "../src/core/contracts.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { planTools } from "../src/agent/tools/plan.ts";

function makeMemoryStore(chatId: string): {
	chatStore: ChatStore;
	getSavedTree: () => PlanTree | undefined;
} {
	let savedTree: PlanTree | undefined;
	const chatStore = {
		getChat(id: string): ChatRecord | null {
			if (id !== chatId) return null;
			return { id, title: "Test", createdAt: 0, updatedAt: 0 } as unknown as ChatRecord;
		},
		saveTree(id: string, tree: PlanTree): void {
			if (id === chatId) savedTree = tree;
		},
	} as unknown as ChatStore;
	return { chatStore, getSavedTree: () => savedTree };
}

async function callPlanInit(
	tools: ReturnType<typeof planTools>,
	mermaid: string,
): Promise<{ text: string; details: PlanToolResult }> {
	const t = tools.plan_init!;
	const res = await t.execute("test-call", { mermaid });
	const first = res.content[0];
	const text = first && first.type === "text" ? first.text : "";
	return { text, details: res.details as PlanToolResult };
}

describe("plan_init — units", () => {
	// plan 001 part 1: passes parsed.plan.units to createTree, saves tree, returns unitIds in text and units in details.tree.
	it("saves units on tree and includes ordered unitIds in result text when units exist", async () => {
		const chatId = "chat-units-1";
		const { chatStore, getSavedTree } = makeMemoryStore(chatId);
		const tools = planTools({ chatId, chatStore });

		const { text, details } = await callPlanInit(
			tools,
			[
				"graph TD",
				"  subgraph basics[Grundlagen]",
				"    %% source: Skript Kap. 1, S. 3–20",
				"    ode1[ODEs erster Ordnung] --> expeig[Eigenwerte]",
				"  end",
				"  subgraph stab[Stabilität]",
				"    poles[Pole] --> loop[Regelkreis]",
				"  end",
				"  expeig --> poles",
			].join("\n"),
		);

		assert.equal(details.ok, true);
		assert.deepEqual(details.tree?.units, [
			{
				id: "basics",
				title: "Grundlagen",
				source: "Skript Kap. 1, S. 3–20",
				nodeIds: ["ode1", "expeig"],
			},
			{
				id: "stab",
				title: "Stabilität",
				nodeIds: ["poles", "loop"],
			},
		]);
		assert.deepEqual(getSavedTree()?.units, details.tree?.units);

		const parsedText = JSON.parse(text) as {
			ok: boolean;
			nodeIds: string[];
			unitIds?: string[];
			reminder: string;
		};
		assert.equal(parsedText.ok, true);
		assert.deepEqual(parsedText.nodeIds, ["ode1", "expeig", "poles", "loop"]);
		assert.deepEqual(parsedText.unitIds, ["basics", "stab"]);
		assert.equal(typeof parsedText.reminder, "string");
	});

	// plan 001 part 1: without subgraphs, units and unitIds stay absent.
	it("omits unitIds from text and units from tree when the plan has no subgraphs", async () => {
		const chatId = "chat-no-units";
		const { chatStore, getSavedTree } = makeMemoryStore(chatId);
		const tools = planTools({ chatId, chatStore });

		const { text, details } = await callPlanInit(tools, "graph TD\n  a[A] --> b[B]");

		assert.equal(details.ok, true);
		assert.equal(details.tree?.units, undefined);
		assert.equal("units" in details.tree!, false);
		assert.equal(getSavedTree()?.units, undefined);

		const parsedText = JSON.parse(text) as Record<string, unknown>;
		assert.equal(parsedText.ok, true);
		assert.equal("unitIds" in parsedText, false);
	});

	// plan 001 part 1: invalid unit structure returns ok:false without saving.
	it("returns ok:false without saving when unit order check fails", async () => {
		const chatId = "chat-bad-units";
		const { chatStore, getSavedTree } = makeMemoryStore(chatId);
		const tools = planTools({ chatId, chatStore });

		const { details } = await callPlanInit(
			tools,
			[
				"graph TD",
				"  subgraph u1[First]",
				"    a[A]",
				"  end",
				"  subgraph u2[Second]",
				"    b[B]",
				"  end",
				"  b --> a",
			].join("\n"),
		);

		assert.equal(details.ok, false);
		assert.match(details.error ?? "", /later unit/);
		assert.equal(getSavedTree(), undefined);
	});

	// plan 001 part 1: confirmed tool description and mermaid parameter description.
	it("documents flat mermaid subgraphs in tool and mermaid parameter descriptions and drops 'no subgraphs'", () => {
		const { chatStore } = makeMemoryStore("chat-desc");
		const tools = planTools({ chatId: "chat-desc", chatStore });
		const init = tools.plan_init!;
		const mermaidDesc = (
			init.parameters as { properties: { mermaid: { description: string } } }
		).properties.mermaid.description;

		const unitGuidance =
			"Group nodes into ordered units with flat mermaid subgraphs: `subgraph slug[Unit Title]` … `end`, one coherent topic each, optional `%% source: <where in the learner's material>` inside. Every node in exactly one unit; a prerequisite never sits in a later unit. A plan without subgraphs is one unit.";

		assert.equal(init.description.includes(unitGuidance), true);
		assert.equal(mermaidDesc.includes("no subgraphs"), false);
		assert.equal(mermaidDesc.includes("no styles or classes"), true);
		assert.equal(mermaidDesc.includes(unitGuidance), true);
	});
});
