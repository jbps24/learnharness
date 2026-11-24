import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { StatsBar } from "../components/stats-bar.tsx";

function renderStatsBar(node: React.ReactElement) {
	return renderToStaticMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
}

describe("StatsBar learningMinutes", () => {
	// plan 002 part 9: StatsBar with learningMinutes={38} renders "38 min" in data-testid="learning-minutes" before dictationSlot and after session data
	it("renders learning-minutes after session data and before dictationSlot when defined", () => {
		const html = renderStatsBar(
			<StatsBar
				chatId="chat_1"
				turns={[]}
				learningMinutes={38}
				dictationSlot={<span data-testid="dictation-probe">mic</span>}
			/>,
		);
		assert.match(html, /data-testid="learning-minutes"[^>]*>38 min</);
		const summaryIdx = html.indexOf('data-testid="stats-summary"');
		const minutesIdx = html.indexOf('data-testid="learning-minutes"');
		const dictationIdx = html.indexOf('data-testid="dictation-probe"');
		assert.ok(summaryIdx !== -1 && minutesIdx !== -1 && dictationIdx !== -1);
		assert.ok(summaryIdx < minutesIdx, "learning-minutes should appear after session data");
		assert.ok(minutesIdx < dictationIdx, "learning-minutes should appear before dictationSlot");
	});

	// plan 002 part 9: StatsBar renders "<n> min" in plain minutes, including 0 and >= 60
	it("renders 0 min and plain minutes >= 60 without converting to hours", () => {
		const zeroHtml = renderStatsBar(<StatsBar chatId="chat_1" turns={[]} learningMinutes={0} />);
		assert.match(zeroHtml, /data-testid="learning-minutes"[^>]*>0 min</);

		const overHourHtml = renderStatsBar(<StatsBar chatId="chat_1" turns={[]} learningMinutes={72} />);
		assert.match(overHourHtml, /data-testid="learning-minutes"[^>]*>72 min</);
	});

	// plan 002 part 9: StatsBar without learningMinutes renders no learning-minutes element
	it("renders no learning-minutes element when learningMinutes is undefined", () => {
		const html = renderStatsBar(<StatsBar turns={[]} />);
		assert.ok(!html.includes('data-testid="learning-minutes"'));
	});
});
