import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { BreakScreen } from "../components/break-screen.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

declare global {
	interface Window {
		Event: typeof Event;
	}
}

const BEFORE_ZERO_ADVICE =
	"Stand up, move, look out of a window. Leave the phone. The lesson waits where you left it.";
const PAST_ZERO_ADVICE =
	"Time's up. The lesson is waiting where you left it.";

function withDom(run: (ctx: { document: Document; window: Window }) => void, node: ReactNode) {
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

	const container = document.getElementById("root")!;
	const root = createRoot(container);
	try {
		act(() => {
			root.render(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
		});
		run({ document, window: window as unknown as Window });
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
}

describe("BreakScreen", () => {
	// plan 002 part 6: BreakScreen mounts as a portal (data-testid="break-screen") showing 9:41 at 19 s and before-zero advice
	it("shows 9:41 at 19 s into a 10 min break with before-zero advice", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		const takenAt = 1_000_000 - 19_000;
		withDom(
			({ document }) => {
				const screen = document.body.querySelector('[data-testid="break-screen"]');
				assert.ok(screen, "portal mounts into document.body with data-testid='break-screen'");
				const text = screen.textContent ?? "";
				assert.ok(text.includes("9:41"), `expected 9:41 in "${text}"`);
				assert.ok(text.includes(BEFORE_ZERO_ADVICE));
				assert.ok(text.includes("Continue lesson"));
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => {}} />,
		);
	});

	// plan 002 part 6: BreakScreen shows +1:23 past zero and past-zero advice
	it("shows +1:23 past zero with past-zero advice", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		const takenAt = 1_000_000 - (10 * 60_000 + 83_000);
		withDom(
			({ document }) => {
				const screen = document.body.querySelector('[data-testid="break-screen"]');
				assert.ok(screen);
				const text = screen.textContent ?? "";
				assert.ok(text.includes("+1:23"), `expected +1:23 in "${text}"`);
				assert.ok(text.includes(PAST_ZERO_ADVICE));
				assert.ok(text.includes("Continue lesson"));
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => {}} />,
		);
	});

	// plan 002 part 6: Esc calls onContinue once
	it("calls onContinue once when Escape is pressed", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		let calls = 0;
		const takenAt = 1_000_000 - 19_000;
		withDom(
			({ document, window }) => {
				const event = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.assign(event, { key: "Escape" });
				act(() => {
					document.dispatchEvent(event);
				});
				assert.equal(calls, 1);
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => { calls++; }} />,
		);
	});

	// plan 002 part 6: breakCountdown ticks every 250 ms (9:41 at 19 s becomes 9:40 one second later)
	it("updates the countdown as time advances in 250 ms ticks", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		const takenAt = 1_000_000 - 19_000;
		withDom(
			({ document }) => {
				const read = () => document.body.querySelector('[data-testid="break-screen"]')?.textContent ?? "";
				assert.ok(read().includes("9:41"), `expected 9:41 in "${read()}"`);
				for (let i = 0; i < 4; i++) {
					act(() => {
						t.mock.timers.tick(250);
					});
				}
				assert.ok(read().includes("9:40"), `expected 9:40 in "${read()}"`);
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => {}} />,
		);
	});

	// plan 002 part 6: Esc is the only key out; other keys do not call onContinue
	it("does not call onContinue for non-Escape keys", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		let calls = 0;
		const takenAt = 1_000_000 - 19_000;
		withDom(
			({ document, window }) => {
				for (const key of ["Enter", " ", "a", "Tab"]) {
					const event = new window.Event("keydown", { bubbles: true, cancelable: true });
					Object.assign(event, { key });
					act(() => {
						document.dispatchEvent(event);
					});
				}
				assert.equal(calls, 0);
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => { calls++; }} />,
		);
	});

	// plan 002 part 6: Continue lesson button calls onContinue once
	it("calls onContinue once when Continue lesson button is clicked", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
		let calls = 0;
		const takenAt = 1_000_000 - 19_000;
		withDom(
			({ document }) => {
				const screen = document.body.querySelector('[data-testid="break-screen"]');
				assert.ok(screen);
				const buttons = [...screen.querySelectorAll("button")];
				const continueBtn = buttons.find((b) => (b.textContent ?? "").includes("Continue lesson"));
				assert.ok(continueBtn, "Continue lesson button is rendered");
				act(() => {
					continueBtn.click();
				});
				assert.equal(calls, 1);
			},
			<BreakScreen takenAt={takenAt} lengthMinutes={10} onContinue={() => { calls++; }} />,
		);
	});
});
