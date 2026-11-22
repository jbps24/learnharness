import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { DRAW_STATUS_MIN, kbdEventForAction, type LhMessage } from "../src/core/index.ts";
import { SessionFind, SESSION_FIND_ACTIVE_HIGHLIGHT, SESSION_FIND_HIGHLIGHT } from "../components/session-find.tsx";
import type { SessionScrollContext } from "../components/session-navigation.tsx";
import { partFindRanges } from "../components/session-find-dom.ts";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
if (typeof dom.window.addEventListener !== "function") {
	const bus = new EventTarget();
	dom.window.addEventListener = bus.addEventListener.bind(bus);
	dom.window.removeEventListener = bus.removeEventListener.bind(bus);
	dom.window.dispatchEvent = bus.dispatchEvent.bind(bus);
}
const KeyEventCtor = dom.window.KeyboardEvent ?? class extends dom.window.Event {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	constructor(type: string, init: KeyboardEventInit = {}) {
		super(type, init);
		this.key = init.key ?? "";
		this.shiftKey = !!init.shiftKey;
		this.metaKey = !!init.metaKey;
		this.ctrlKey = !!init.ctrlKey;
		this.altKey = !!init.altKey;
	}
};
dom.window.HTMLElement.prototype.focus ??= () => {};
dom.window.HTMLElement.prototype.scrollIntoView ??= () => {};
// Real keys now reach the scroll path, which measures the matched Range.
(dom.window.HTMLElement.prototype as { scrollTo?: () => void }).scrollTo ??= () => {};
{
	const probe = dom.document.createElement("div");
	probe.innerHTML = "needle";
	const sample = partFindRanges(probe, "needle")[0];
	if (sample && !sample.getBoundingClientRect) {
		(Object.getPrototypeOf(sample) as { getBoundingClientRect?: () => unknown }).getBoundingClientRect = () =>
			({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
	}
}
if (dom.window.HTMLInputElement && !dom.window.HTMLInputElement.prototype.select) {
	dom.window.HTMLInputElement.prototype.select = () => {};
}
class MockHighlight extends Set<Range> {
	priority = 0;
}

const g = globalThis as Record<string, unknown>;
g.React = React;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.window = dom.window;
g.document = dom.document;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.KeyboardEvent = KeyEventCtor;
g.MutationObserver = dom.window.MutationObserver;
g.Highlight = MockHighlight;
g.CSS = { highlights: new Map<string, MockHighlight>() };
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

const userMsg = (id: string, text: string): LhMessage =>
	({ id, role: "user", content: text, timestamp: 1 }) as never;

const assistantMsg = (id: string, text: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 2 }) as never;

const quizAnswerMsg = (id: string, callId: string, questionText: string, explanation: string): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text: "A" }],
		isError: false,
		details: {
			kind: "quiz",
			questionText,
			dontKnow: false,
			answers: [{ index: 0, label: "A" }],
			explanation,
			answeredAt: "2026-11-22T00:00:00.000Z",
		},
		timestamp: 3,
	}) as never;

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value");
	if (descriptor?.set) descriptor.set.call(input, value);
	else input.value = value;
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function dropdownText(host: Element): string {
	return host.querySelector('[data-testid="session-find"]')?.textContent ?? "";
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let activeRoot: Root | null = null;

afterEach(async () => {
	if (activeRoot) {
		await act(async () => {
			activeRoot!.unmount();
		});
		activeRoot = null;
	}
	dom.document.body.innerHTML = "";
	(CSS.highlights as Map<string, unknown>).clear();
});

async function mountFind(props: {
	messages?: readonly LhMessage[];
	drawnStart?: number;
	scopeHtml?: string;
}) {
	const host = dom.document.createElement("div");
	const headerHost = dom.document.createElement("div");
	const scope = dom.document.createElement("div");
	scope.setAttribute("data-session-find-root", "");
	if (props.scopeHtml) scope.innerHTML = props.scopeHtml;
	host.appendChild(headerHost);
	host.appendChild(scope);
	dom.document.body.appendChild(host);

	const scopeRef = { current: scope as unknown as HTMLDivElement };
	const scrollContextRef = { current: { scrollRef: { current: scope as unknown as HTMLElement }, stopScroll: () => {} } as SessionScrollContext };

	const root = createRoot(headerHost as unknown as HTMLElement);
	activeRoot = root;
	await act(async () => {
		root.render(
			<SessionFind
				scopeRef={scopeRef}
				scrollContextRef={scrollContextRef}
				messages={props.messages}
				drawnStart={props.drawnStart}
			/>,
		);
	});
	return { host, headerHost, scope };
}

describe("SessionFind header dropdown", () => {
	// plan 003 part 5 §1: SessionFind renders the round icon button (testid find-open) even without a plan, and the old bar testid does not render when closed
	it("renders find-open icon button without a plan and does not render the old bar when closed", async () => {
		const { headerHost } = await mountFind({ messages: [] });
		const openButton = headerHost.querySelector('[data-testid="find-open"]');
		assert.ok(openButton, "find-open button must render in header");
		assert.equal(openButton!.getAttribute("aria-label"), "Find in session");
		assert.equal(openButton!.getAttribute("title"), "Find in session (⌘F)");
		assert.equal(headerHost.querySelector('[data-testid="session-find"]'), null, "old bar / closed dropdown must not render");
	});

	// plan 003 part 5 §3, §4: typing after the 200 ms pause lists hits newest first with labels, <mark> snippet, and 1/N counter
	it("typing (after the pause) lists hits newest first with labels", async () => {
		const messages = [
			userMsg("m1", "First mention of gradient"),
			assistantMsg("m2", "Second mention of gradient"),
		];
		const { headerHost } = await mountFind({
			messages,
			scopeHtml: `<div data-find-part="m1:you">First mention of gradient</div><div data-find-part="m2-t0">Second mention of gradient</div>`,
		});

		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const dropdown = headerHost.querySelector('[data-testid="session-find"]');
		assert.ok(dropdown, "dropdown opens");
		assert.equal(dropdown!.getAttribute("role"), "search");

		const input = dropdown!.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		assert.ok(input, "find input exists");

		await act(async () => {
			setInputValue(input, "gradient");
		});
		assert.equal(headerHost.querySelectorAll('[data-testid="find-hit"]').length, 0, "debounced before 200 ms");

		await act(async () => {
			await wait(240);
		});

		const hits = [...headerHost.querySelectorAll('[data-testid="find-hit"]')];
		assert.equal(hits.length, 2);
		assert.match(hits[0]!.textContent ?? "", /Teacher/);
		assert.match(hits[1]!.textContent ?? "", /You/);
		assert.ok(hits[0]!.querySelector("mark"), "snippet marks the match");
		assert.match(dropdownText(headerHost), /\b1\/2\b/);
	});

	// plan 003 part 5 §4: with no hits the list says "No matches in this session."
	it("shows the empty text when nothing matches", async () => {
		const { headerHost } = await mountFind({
			messages: [assistantMsg("m1", "Hello there")],
			scopeHtml: `<div data-find-part="m1-t0">Hello there</div>`,
		});
		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		await act(async () => {
			setInputValue(input, "zzzz");
			await wait(240);
		});
		assert.match(dropdownText(headerHost), /No matches in this session\./);
	});

	// plan 003 part 5 §2: × and the icon close the dropdown
	it("× and the icon close the dropdown", async () => {
		const { headerHost } = await mountFind({ messages: [] });
		const open = () => headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!;
		await act(async () => {
			open().click();
		});
		assert.ok(headerHost.querySelector('[data-testid="session-find"]'));
		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[aria-label="Close Find (Esc)"]')!.click();
		});
		assert.equal(headerHost.querySelector('[data-testid="session-find"]'), null, "× closes");
		await act(async () => {
			open().click();
		});
		assert.ok(headerHost.querySelector('[data-testid="session-find"]'));
		await act(async () => {
			open().click();
		});
		assert.equal(headerHost.querySelector('[data-testid="session-find"]'), null, "icon closes");
	});

	// plan 003 part 5 §5: Enter selects older and Shift+Enter selects newer, wrapping at both ends
	it("Enter selects older and Shift+Enter newer, with wrap", async () => {
		const messages = [
			userMsg("m1", "Older alpha"),
			assistantMsg("m2", "Newer alpha"),
		];
		const { headerHost } = await mountFind({
			messages,
			scopeHtml: `<div data-find-part="m1:you">Older alpha</div><div data-find-part="m2-t0">Newer alpha</div>`,
		});

		await act(async () => {
			dom.window.dispatchEvent(new dom.window.CustomEvent(kbdEventForAction("find")));
		});
		const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		await act(async () => {
			setInputValue(input, "alpha");
			await wait(240);
		});
		assert.match(dropdownText(headerHost), /\b1\/2\b/);

		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Enter", bubbles: true }));
		});
		assert.match(dropdownText(headerHost), /\b2\/2\b/);

		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Enter", bubbles: true }));
		});
		assert.match(dropdownText(headerHost), /\b1\/2\b/, "Enter wraps to newest");

		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		});
		assert.match(dropdownText(headerHost), /\b2\/2\b/, "Shift+Enter wraps to older");
	});

	// plan 003 part 5 §5: hit with sourceMessageId in earlier history dispatches lh:draw-to-message and shows Drawing earlier history… when size >= DRAW_STATUS_MIN
	it("a hit in the earlier history dispatches lh:draw-to-message", async () => {
		const padding = "x".repeat(DRAW_STATUS_MIN);
		const messages = [
			userMsg("m-early", `Early needle ${padding}`),
			assistantMsg("m-late", "Recent message"),
		];
		const dispatched: Array<{ messageId?: string }> = [];
		const onDraw = (event: Event) => {
			dispatched.push((event as CustomEvent<{ messageId?: string }>).detail);
		};
		dom.window.addEventListener("lh:draw-to-message", onDraw);
		try {
			const { headerHost } = await mountFind({
				messages,
				drawnStart: 1,
				scopeHtml: `<div data-find-part="m-late-t0">Recent message</div>`,
			});
			await act(async () => {
				headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
			});
			const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
			await act(async () => {
				setInputValue(input, "needle");
				await wait(240);
			});

			assert.equal(dispatched.length, 1);
			assert.equal(dispatched[0]?.messageId, "m-early");
			assert.match(
				headerHost.querySelector('[data-testid="session-find"]')?.textContent ?? "",
				/Drawing earlier history…/,
			);
		} finally {
			dom.window.removeEventListener("lh:draw-to-message", onDraw);
		}
	});

	// plan 003 part 5 §5: hit in a collapsed, already-revealed explanation dispatches lh:find-reveal
	it("a hit in a collapsed explanation dispatches lh:find-reveal", async () => {
		const messages = [
			{
				id: "m-call",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "quiz", arguments: { question: "What is the derivative?", options: [{ label: "A", value: "a" }], correctAnswer: "a", explanation: "Because the chain rule multiplies rates" } }],
				timestamp: 2,
			} as never,
			quizAnswerMsg("m-quiz", "call-1", "What is the derivative?", "Because the chain rule multiplies rates"),
		];
		const revealed: Array<{ key?: string; field?: string }> = [];
		const onReveal = (event: Event) => {
			revealed.push((event as CustomEvent<{ key?: string; field?: string }>).detail);
		};
		dom.window.addEventListener("lh:find-reveal", onReveal);
		try {
			const { headerHost } = await mountFind({
				messages,
				scopeHtml: `<div data-testid="answered-card"><div>What is the derivative?</div></div>`,
			});
			await act(async () => {
				headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
			});
			const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
			await act(async () => {
				setInputValue(input, "multiplies");
				await wait(240);
			});

			assert.equal(revealed.length, 1);
			assert.ok(revealed[0]?.key, "reveal detail includes part key");
			assert.ok(revealed[0]?.field, "reveal detail includes collapsed field");
		} finally {
			dom.window.removeEventListener("lh:find-reveal", onReveal);
		}
	});

	// plan 003 part 5 §1, §7: Esc closes dropdown and clears highlights; reopening keeps the query
	it("Esc closes and clears the highlights; reopening keeps the query", async () => {
		const messages = [assistantMsg("m1", "Persistent needle here")];
		const { headerHost } = await mountFind({
			messages,
			scopeHtml: `<div data-find-part="m1-t0">Persistent needle here</div>`,
		});

		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		await act(async () => {
			setInputValue(input, "needle");
			await wait(240);
		});

		const highlights = CSS.highlights as unknown as Map<string, MockHighlight>;
		assert.ok((highlights.get(SESSION_FIND_HIGHLIGHT)?.size ?? 0) > 0, "all-hits highlight is set");
		assert.ok((highlights.get(SESSION_FIND_ACTIVE_HIGHLIGHT)?.size ?? 0) > 0, "active-hit highlight is set");

		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Escape", bubbles: true }));
		});
		assert.equal(headerHost.querySelector('[data-testid="session-find"]'), null, "Esc closes dropdown");
		assert.equal(highlights.size, 0, "highlights cleared on close");

		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const reopenedInput = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]');
		assert.ok(reopenedInput, "dropdown reopens");
		assert.equal(reopenedInput!.value, "needle", "query is preserved on reopen");
	});

	// plan 003 part 5 §3, §4: no hits means a 0/0 counter
	it("shows 0/0 when nothing matches", async () => {
		const { headerHost } = await mountFind({ messages: [assistantMsg("m1", "Hello there")] });
		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		await act(async () => {
			setInputValue(input, "zzzz");
			await wait(240);
		});
		assert.equal(headerHost.querySelector('[data-testid="session-find-count"]')?.textContent, "0/0");
	});

	// plan 003 part 5 §5: Shift+Enter (not Alt+Enter) selects the newer hit
	it("Shift+Enter steps toward the newest and Alt+Enter steps older", async () => {
		const messages = [
			userMsg("m1", "alpha one"),
			assistantMsg("m2", "alpha two"),
			userMsg("m3", "alpha three"),
		];
		const { headerHost } = await mountFind({ messages });
		await act(async () => {
			headerHost.querySelector<HTMLButtonElement>('[data-testid="find-open"]')!.click();
		});
		const input = headerHost.querySelector<HTMLInputElement>('input[aria-label="Find in session"]')!;
		await act(async () => {
			setInputValue(input, "alpha");
			await wait(240);
		});
		assert.match(dropdownText(headerHost), /\b1\/3\b/);
		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		});
		assert.match(dropdownText(headerHost), /\b3\/3\b/, "Shift+Enter wraps to the oldest from the newest");
		await act(async () => {
			input.dispatchEvent(new KeyEventCtor("keydown", { key: "Enter", altKey: true, bubbles: true }));
		});
		assert.match(dropdownText(headerHost), /\b1\/3\b/, "Alt+Enter is a plain Enter: older, wrapping");
	});
});

describe("partFindRanges", () => {
	const part = (html: string, attrs = ""): HTMLElement => {
		const host = dom.document.createElement("div");
		host.innerHTML = `<div data-find-part="k"${attrs}>${html}</div>`;
		dom.document.body.appendChild(host);
		return host.firstElementChild as HTMLElement;
	};

	// plan 003 part 5 §5: the range covers the first through the last matched character
	it("returns ranges covering exactly the matched text", () => {
		const ranges = partFindRanges(part("Find the needle here"), "needle");
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0]!.toString(), "needle");
	});

	// plan 003 part 5 §5: a hidden part, or one in a hidden ancestor, has no matches
	it("returns no ranges for a hidden part or a part in a hidden ancestor", () => {
		assert.equal(partFindRanges(part("needle", " hidden"), "needle").length, 0);
		const host = dom.document.createElement("div");
		host.setAttribute("hidden", "");
		host.innerHTML = `<div data-find-part="k">needle</div>`;
		dom.document.body.appendChild(host);
		assert.equal(partFindRanges(host.firstElementChild as HTMLElement, "needle").length, 0);
	});
});

describe("find-reveal listeners", () => {
	const reveal = (detail: { key?: string; field?: string }) =>
		act(async () => {
			dom.window.dispatchEvent(new dom.window.CustomEvent("lh:find-reveal", { detail }));
		});
	const mount = async (node: React.ReactElement) => {
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		const root = createRoot(host as unknown as HTMLElement);
		activeRoot = root;
		await act(async () => { root.render(node); });
		return { host, root };
	};
	const expanded = (host: Element) => host.querySelector('[data-testid="t-trigger"]')!.getAttribute("aria-expanded");

	// plan 003 part 5 §5: a thinking block opens only for its own key AND field
	it("ThinkingBlock opens only when both key and field match", async () => {
		const { host } = await mount(<ThinkingBlock testId="t" text="secret" findKey="k" findField="thinking" />);
		assert.equal(expanded(host), "false");
		await reveal({ key: "other", field: "thinking" });
		assert.equal(expanded(host), "false", "other key");
		await reveal({ key: "k", field: "explanation" });
		assert.equal(expanded(host), "false", "other field");
		await reveal({ key: "k", field: "thinking" });
		assert.equal(expanded(host), "true");
	});

	// plan 003 part 5 §5: a block with no field ignores reveal events
	it("ThinkingBlock without a field ignores a reveal for its key", async () => {
		const { host } = await mount(<ThinkingBlock testId="t" text="secret" findKey="k" />);
		await reveal({ key: "k" });
		assert.equal(expanded(host), "false");
	});

	// plan 003 part 5 §5: the listener follows the field prop
	it("ThinkingBlock follows a changed field", async () => {
		const { host, root } = await mount(<ThinkingBlock testId="t" text="secret" findKey="k" findField="thinking" />);
		await act(async () => { root.render(<ThinkingBlock testId="t" text="secret" findKey="k" findField="explanation" />); });
		await reveal({ key: "k", field: "thinking" });
		assert.equal(expanded(host), "false", "the old field no longer matches");
		await reveal({ key: "k", field: "explanation" });
		assert.equal(expanded(host), "true");
	});

	const answer = {
		kind: "quiz", questionText: "What is it?", dontKnow: false, answers: [{ index: 0, label: "A" }],
		explanation: "Because reasons", thinking: "my own thought", answeredAt: "2026-11-22T00:00:00.000Z",
	} as never;
	const whyOpen = (host: Element) => !!host.textContent?.includes("Because reasons");

	// plan 003 part 5 §5: the answered card follows its findKey and routes the field
	it("AnsweredCard follows a changed findKey", async () => {
		const { host, root } = await mount(<AnsweredCard answer={answer} findKey="k1" />);
		await act(async () => { root.render(<AnsweredCard answer={answer} findKey="k2" />); });
		await reveal({ key: "k2", field: "explanation" });
		assert.ok(whyOpen(host), "the new key opens the explanation");
	});

	it("AnsweredCard routes the thinking field to the your-thinking block only", async () => {
		const { host } = await mount(<AnsweredCard answer={answer} findKey="k1" />);
		const thinking = () => host.querySelector('[data-testid="your-thinking-trigger"]')!.getAttribute("aria-expanded");
		assert.equal(thinking(), "false");
		await reveal({ key: "k1", field: "thinking" });
		assert.equal(thinking(), "true");
		assert.ok(!whyOpen(host), "the explanation stays closed");
	});
});
