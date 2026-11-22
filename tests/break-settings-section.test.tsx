import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { BreakSettings } from "../src/core/settings.ts";

function renderAgentSection(breaks?: BreakSettings): string {
	return renderToStaticMarkup(
		<InteractionLayersProvider>
			<AgentSection
				agent={undefined}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				breaks={breaks}
				onSectionChange={() => true}
				onModelsChange={() => {}}
				onCompactionChange={() => true}
				onBreaksChange={() => true}
			/>
		</InteractionLayersProvider>,
	);
}

describe("AgentSection Breaks group", () => {
	// plan 002 part 1: SettingsGroup label="Breaks" testid="group-breaks" after "Context", with three rows when enabled
	it("renders the Breaks group after Context with toggle and both number rows by default", () => {
		const html = renderAgentSection(undefined);
		const contextIdx = html.indexOf('data-testid="group-context"');
		const breaksIdx = html.indexOf('data-testid="group-breaks"');
		assert.notEqual(contextIdx, -1);
		assert.notEqual(breaksIdx, -1);
		assert.equal(breaksIdx > contextIdx, true);

		assert.equal(html.includes("Breaks"), true);
		assert.equal(html.includes("Break suggestions"), true);
		assert.equal(html.includes("Off = no break offers; you can still ask for a break"), true);
		assert.equal(html.includes('aria-label="Break suggestions"'), true);
		assert.equal(html.includes('aria-checked="true"'), true);

		assert.equal(html.includes("Break interval"), true);
		assert.equal(html.includes("minutes of learning (20–90)"), true);
		assert.equal(html.includes("Break length"), true);
		assert.equal(html.includes("minutes (5–20)"), true);
	});

	// plan 002 part 1: the two number rows show only while the toggle is on; hidden when enabled: false
	it("renders the group with the toggle and hides the number rows when enabled is false", () => {
		const html = renderAgentSection({ enabled: false });
		assert.equal(html.includes('data-testid="group-breaks"'), true);
		assert.equal(html.includes("Break suggestions"), true);
		assert.equal(html.includes("Off = no break offers; you can still ask for a break"), true);
		assert.equal(html.includes('aria-label="Break suggestions"'), true);

		assert.equal(html.includes("Break interval"), false);
		assert.equal(html.includes("minutes of learning (20–90)"), false);
		assert.equal(html.includes("Break length"), false);
		assert.equal(html.includes("minutes (5–20)"), false);
	});

	// plan 002 part 1: number rows show with configured values when enabled is true
	it("renders the number rows with configured values when enabled is true", () => {
		const html = renderAgentSection({ enabled: true, intervalMinutes: 60, lengthMinutes: 15 });
		assert.equal(html.includes('data-testid="group-breaks"'), true);
		assert.equal(html.includes("Break interval"), true);
		assert.equal(html.includes("Break length"), true);
		assert.equal(html.includes('value="60"'), true);
		assert.equal(html.includes('value="15"'), true);
	});

	// plan 004 part 1: Reset after inactivity row always shows when suggestions are on and when off
	it("renders the Reset after inactivity row both when break suggestions are on and when off", () => {
		for (const breaks of [undefined, { enabled: false }, { enabled: false, resetMinutes: 30 }] as const) {
			const html = renderAgentSection(breaks);
			assert.equal(html.includes('data-testid="breaks-row-reset"'), true);
			assert.equal(html.includes("Reset after inactivity"), true);
			assert.equal(html.includes("minutes without activity before the learning clock restarts (5–60)"), true);
			assert.equal(html.includes('data-testid="input-breaks-reset"'), true);
			assert.equal(html.includes('aria-label="reset after inactivity"'), true);
			assert.equal(html.includes(`value="${breaks?.resetMinutes ?? 15}"`), true);
		}
	});

	// plan 004 part 1: third row after Break length inside group-breaks, CommitInput type="number"
	it("places the reset row after the length row with a number input", () => {
		const html = renderAgentSection({ enabled: true });
		const group = html.indexOf('data-testid="group-breaks"');
		const length = html.indexOf('data-testid="breaks-row-length"', group);
		const reset = html.indexOf('data-testid="breaks-row-reset"', group);
		assert.notEqual(length, -1);
		assert.equal(reset > length, true);
		const tag = html.slice(html.lastIndexOf("<input", html.indexOf('data-testid="input-breaks-reset"')));
		assert.equal(tag.slice(0, tag.indexOf(">")).includes('type="number"'), true);
	});

	// plan 004 part 1: committing 30 calls onBreaksChange with resetMinutes: 30 and other fields kept; "" writes nothing; 90 clamps to 60
	it("commits resetMinutes with clamping and ignores empty input", async () => {
		const { parseHTML } = await import("linkedom");
		const { act } = await import("react");
		const { createRoot } = await import("react-dom/client");

		const win = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
		const prev = {
			IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
			window: globalThis.window,
			document: globalThis.document,
			HTMLElement: globalThis.HTMLElement,
			Node: globalThis.Node,
			Event: globalThis.Event,
			CustomEvent: globalThis.CustomEvent,
			fetch: globalThis.fetch,
		};
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		globalThis.window = win as never;
		globalThis.document = win.document as never;
		globalThis.HTMLElement = win.HTMLElement as never;
		globalThis.Node = win.Node as never;
		globalThis.Event = win.Event as never;
		globalThis.CustomEvent = win.CustomEvent as never;
		globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ teacher: [], prober: [], practice: [], keys: [] }), { status: 200 }))) as never;

		const calls: BreakSettings[] = [];
		const initial: BreakSettings = { enabled: true, intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 };
		const root = createRoot(win.document.getElementById("root")!);
		try {
			await act(async () => {
				root.render(
					<InteractionLayersProvider>
						<AgentSection
							agent={undefined}
							models={undefined}
							graph={undefined}
							compaction={undefined}
							breaks={initial}
							onSectionChange={() => true}
							onModelsChange={() => {}}
							onCompactionChange={() => true}
							onBreaksChange={(next) => {
								calls.push(next);
								return true;
							}}
						/>
					</InteractionLayersProvider>,
				);
			});

			const input = win.document.querySelector('[data-testid="input-breaks-reset"]') as HTMLInputElement | null;
			assert.ok(input, "expected input-breaks-reset to be rendered");

			const commitValue = async (val: string) => {
				await act(async () => {
					input.value = val;
					input.dispatchEvent(new win.Event("input", { bubbles: true }));
					input.dispatchEvent(new win.Event("focusout", { bubbles: true }));
				});
			};

			await commitValue("30");
			assert.deepEqual(calls, [{ enabled: true, intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 30 }]);

			await commitValue("");
			assert.equal(calls.length, 1);

			await commitValue("90");
			assert.deepEqual(calls[1], { enabled: true, intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 60 });

			// clamp to min and round (plan 004: clamp to BREAK_RESET_RANGE and round)
			await commitValue("2");
			assert.equal(calls[2]?.resetMinutes, 5);
			await commitValue("12.4");
			assert.equal(calls[3]?.resetMinutes, 12);

			// non-finite input writes nothing
			await commitValue("abc");
			assert.equal(calls.length, 4);
		} finally {
			await act(async () => {
				root.unmount();
			});
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
			globalThis.window = prev.window;
			globalThis.document = prev.document;
			globalThis.HTMLElement = prev.HTMLElement;
			globalThis.Node = prev.Node;
			globalThis.Event = prev.Event;
			globalThis.CustomEvent = prev.CustomEvent;
			globalThis.fetch = prev.fetch;
		}
	});

	// without an onBreaksChange handler the commit is not accepted, so the typed text stays instead of snapping back
	it("keeps the typed reset value when no handler is wired", async () => {
		const { parseHTML } = await import("linkedom");
		const { act } = await import("react");
		const { createRoot } = await import("react-dom/client");

		const win = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
		const prev = {
			IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
			window: globalThis.window,
			document: globalThis.document,
			HTMLElement: globalThis.HTMLElement,
			Node: globalThis.Node,
			Event: globalThis.Event,
			CustomEvent: globalThis.CustomEvent,
			fetch: globalThis.fetch,
		};
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		globalThis.window = win as never;
		globalThis.document = win.document as never;
		globalThis.HTMLElement = win.HTMLElement as never;
		globalThis.Node = win.Node as never;
		globalThis.Event = win.Event as never;
		globalThis.CustomEvent = win.CustomEvent as never;
		globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ teacher: [], prober: [], practice: [], keys: [] }), { status: 200 }))) as never;

		const root = createRoot(win.document.getElementById("root")!);
		try {
			await act(async () => {
				root.render(
					<InteractionLayersProvider>
						<AgentSection
							agent={undefined}
							models={undefined}
							graph={undefined}
							compaction={undefined}
							breaks={{ enabled: true, intervalMinutes: 45, lengthMinutes: 10, resetMinutes: 15 }}
							onSectionChange={() => true}
							onModelsChange={() => {}}
							onCompactionChange={() => true}
						/>
					</InteractionLayersProvider>,
				);
			});
			const input = win.document.querySelector('[data-testid="input-breaks-reset"]') as HTMLInputElement;
			await act(async () => {
				input.value = "30";
				input.dispatchEvent(new win.Event("input", { bubbles: true }));
				input.dispatchEvent(new win.Event("focusout", { bubbles: true }));
			});
			assert.equal(input.value, "30");
		} finally {
			await act(async () => {
				root.unmount();
			});
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
			globalThis.window = prev.window;
			globalThis.document = prev.document;
			globalThis.HTMLElement = prev.HTMLElement;
			globalThis.Node = prev.Node;
			globalThis.Event = prev.Event;
			globalThis.CustomEvent = prev.CustomEvent;
			globalThis.fetch = prev.fetch;
		}
	});
});
