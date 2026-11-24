import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { BreakDivider } from "../components/break-divider.tsx";

describe("BreakDivider", () => {
	// plan 002 part 6: offered chip renders Short break?, Take {length} min, and Skip with data-testid="break-divider"
	it("renders offered copy and Take/Skip buttons when offered", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "offered", lengthMinutes: 10 }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.match(html, /data-testid="break-divider"/);
		assert.ok(html.includes("Short break?"));
		assert.ok(html.includes("Take 10 min"));
		assert.ok(html.includes("Skip"));
		const buttons = [...parseHTML(html).document.querySelectorAll("button")];
		assert.equal(buttons.length, 2);
		for (const button of buttons) {
			assert.equal(button.hasAttribute("disabled"), false);
		}
	});

	// plan 002 part 6: Take {length} min calls onTake and Skip calls onSkip when not busy
	it("calls onTake and onSkip when the buttons are clicked", () => {
		const { window, document } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
		const g = globalThis as unknown as Record<string, unknown>;
		const prev = {
			IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
			window: g.window,
			document: g.document,
			HTMLElement: g.HTMLElement,
			Element: g.Element,
			Node: g.Node,
		};
		g.IS_REACT_ACT_ENVIRONMENT = true;
		g.window = window;
		g.document = document;
		g.HTMLElement = window.HTMLElement;
		g.Element = window.Element;
		g.Node = window.Node;
		const root = createRoot(document.getElementById("root")!);
		let takes = 0;
		let skips = 0;
		try {
			act(() => {
				root.render(
					<BreakDivider
						data={{ toolCallId: "c1", state: "offered", lengthMinutes: 10 }}
						busy={false}
						onTake={() => { takes++; }}
						onSkip={() => { skips++; }}
					/>,
				);
			});
			const buttons = [...document.querySelectorAll("button")];
			const take = buttons.find((b) => (b.textContent ?? "").includes("Take 10 min"));
			const skip = buttons.find((b) => (b.textContent ?? "").trim() === "Skip");
			assert.ok(take && skip);
			act(() => {
				take.click();
			});
			assert.equal(takes, 1);
			assert.equal(skips, 0);
			act(() => {
				skip.click();
			});
			assert.equal(takes, 1);
			assert.equal(skips, 1);
		} finally {
			act(() => {
				root.unmount();
			});
			g.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
			g.window = prev.window;
			g.document = prev.document;
			g.HTMLElement = prev.HTMLElement;
			g.Element = prev.Element;
			g.Node = prev.Node;
		}
	});

	// plan 002 part 6: offered buttons are disabled while busy
	it("disables Take and Skip buttons while busy", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "offered", lengthMinutes: 10 }}
				busy={true}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		assert.equal(buttons.length, 2);
		for (const button of buttons) {
			assert.match(button, /\bdisabled\b/);
		}
	});

	// plan 002 part 6: skipped chip renders Break skipped and hides Take/Skip buttons
	it("renders Break skipped without buttons when skipped", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "skipped" }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.match(html, /data-testid="break-divider"/);
		assert.ok(html.includes("Break skipped"));
		assert.ok(!html.includes("<button"));
	});

	// plan 002 part 6: taken chip renders On break and hides Take/Skip buttons
	it("renders On break without buttons when taken", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "taken", takenAt: 1000, lengthMinutes: 10 }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.match(html, /data-testid="break-divider"/);
		assert.ok(html.includes("On break"));
		assert.ok(!html.includes("<button"));
	});

	// plan 002 part 6: ended chip renders Break · {m:ss} and hides Take/Skip buttons
	it("renders Break · {m:ss} without buttons when ended", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "ended", breakMs: 125_000 }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.match(html, /data-testid="break-divider"/);
		assert.ok(html.includes("Break · 2:05"));
		assert.ok(!html.includes("<button"));

		const zeroHtml = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "ended", breakMs: 0 }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.ok(zeroHtml.includes("Break · 0:00"));
	});
});
