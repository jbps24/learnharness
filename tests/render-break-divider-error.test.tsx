import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { BreakDivider } from "../components/break-divider.tsx";

describe("BreakDivider error", () => {
	// plan 002 part 9: BreakDivider offered with error renders data-testid="break-divider-error" and enabled buttons
	it("renders the error line and keeps Take/Skip buttons enabled when offered with an error", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "offered", lengthMinutes: 10 }}
				busy={false}
				error="A turn is running."
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		const doc = parseHTML(html).document;
		const err = doc.querySelector('[data-testid="break-divider-error"]');
		assert.ok(err, "expected data-testid=\"break-divider-error\"");
		assert.ok((err.textContent ?? "").includes("A turn is running."));
		const buttons = [...doc.querySelectorAll("button")];
		assert.equal(buttons.length, 2);
		for (const button of buttons) {
			assert.equal(button.hasAttribute("disabled"), false);
		}
	});

	// plan 002 part 9: BreakDivider offered without error renders no break-divider-error line
	it("renders no error line when offered without an error", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "offered", lengthMinutes: 10 }}
				busy={false}
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.ok(!html.includes('data-testid="break-divider-error"'));
	});

	// plan 002 part 9: BreakDivider in taken state renders no error line even with error
	it("renders no error line in taken state even when error is passed", () => {
		const html = renderToStaticMarkup(
			<BreakDivider
				data={{ toolCallId: "c1", state: "taken", takenAt: 1000, lengthMinutes: 10 }}
				busy={false}
				error="A turn is running."
				onTake={() => {}}
				onSkip={() => {}}
			/>,
		);
		assert.ok(!html.includes('data-testid="break-divider-error"'));
	});
});
