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
});
