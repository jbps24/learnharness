"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
	drawnStartForTarget, drawStatusNeeded, findHits, findUnits, kbdEventForAction, messageAnchorId, projectView, shownText,
	stepSessionMatch, type FindHit, type FindUnit, type LhMessage, type SideChatThread,
} from "@/src/core";
import { partFindRanges } from "@/components/session-find-dom";
import { scrollSessionTarget, type SessionScrollContext } from "@/components/session-navigation";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { hasLegacyInteractionForeground, isInteractionScopeEligible } from "./plugin-input-focus";

export const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";

/** ::highlight() rules live OUTSIDE globals.css on purpose: the PostCSS/
 *  Tailwind v4 pipeline rejects the Custom Highlight pseudo-element as a
 *  parse error, which downed the whole stylesheet. A tiny <style> element,
 *  injected once on first client mount, ships them verbatim. */
const FIND_STYLE_ID = "lh-session-find-style";
export function injectFindStyles(): void {
	if (document.getElementById(FIND_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 25%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--primary); color: var(--primary-foreground); }`;
	document.head.appendChild(style);
}

export function clearSessionFindHighlights(): void {
	if (typeof CSS === "undefined") return;
	CSS.highlights?.delete(SESSION_FIND_HIGHLIGHT);
	CSS.highlights?.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

function publishHighlights(ranges: readonly Range[], active: Range | undefined): void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
	const all = new Highlight();
	for (const range of ranges) all.add(range);
	CSS.highlights.set(SESSION_FIND_HIGHLIGHT, all);
	const strongest = new Highlight();
	strongest.priority = 1;
	if (active) strongest.add(active);
	CSS.highlights.set(SESSION_FIND_ACTIVE_HIGHLIGHT, strongest);
}

/** One-Esc law: a surfaced menu/dialog/cheat sheet outranks this non-modal
 * dropdown, regardless of where focus happened to be left. Closed Radix exits
 * must not block Find once they have stopped being a surfaced layer. */
export function sessionFindHasForegroundLayer(doc: Document, scope?: HTMLElement | null): boolean {
	return hasLegacyInteractionForeground(doc, scope);
}

const FIND_PAUSE_MS = 200;
const FLASH_MS = 2_000;
const EMPTY_MESSAGES: readonly LhMessage[] = [];
const EMPTY_THREADS: readonly SideChatThread[] = [];

const hitId = (hit: FindHit): string => `${hit.unitKey}\0${hit.occurrence}`;
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function partElements(doc: Document): Map<string, HTMLElement> {
	const parts = new Map<string, HTMLElement>();
	for (const element of doc.querySelectorAll<HTMLElement>("[data-find-part]")) parts.set(element.getAttribute("data-find-part")!, element);
	return parts;
}

/** The collapsed section of an answered card that holds this hit's block: the
 *  tucked "Why" explanation or the collapsed "Your thinking" row. Null when
 *  the hit sits in text that is always shown. */
function collapsedField(unit: FindUnit, block: string, native: readonly LhMessage[]): "explanation" | "thinking" | null {
	if (unit.kind !== "Check" && unit.kind !== "Question") return null;
	const parsed = /^(.*):(\d+)$/.exec(unit.key);
	if (!parsed) return null;
	const message = native.find((m) => m.id === parsed[1]);
	const call = message?.role === "assistant" ? message.content[Number(parsed[2])] : undefined;
	if (call?.type !== "toolCall") return null;
	const result = native.find((m) => m.role === "toolResult" && m.toolCallId === call.id);
	const details = result?.role === "toolResult" ? (result.details as Record<string, unknown> | undefined) : undefined;
	if (!details || details.dismissed === true) return null;
	const explanation = typeof details.explanation === "string" ? details.explanation : "";
	if (shownText(explanation).includes(block)) return "explanation";
	const thinking = details.thinking ?? details.note;
	if (typeof thinking === "string" && collapse(thinking).includes(block)) return "thinking";
	return null;
}

/** Mounted for the lifetime of ONE Chat (which is keyed by chatId). Closing
 * keeps the query/reading position; changing sessions resets all local state.
 * The dropdown lives outside scopeRef, so it never finds its own query. */
export interface SessionFindProps {
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
	/** The whole native history; Find looks through it, not through what is drawn. */
	messages?: readonly LhMessage[];
	sideThreads?: readonly SideChatThread[];
	/** The pending question in the dock is visible to the learner. */
	dock?: boolean;
	/** Index of the first drawn native message (0 = everything drawn). */
	drawnStart?: number;
	onOpenSideThread?: (args: { sourceMessageId: string; messageId?: string }) => void;
}

export function SessionFind({
	scopeRef, scrollContextRef, messages = EMPTY_MESSAGES, sideThreads = EMPTY_THREADS, dock = false, drawnStart = 0, onOpenSideThread,
}: SessionFindProps) {
	const controller = useOptionalInteractionLayers();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [drawing, setDrawing] = useState(false);
	useEffect(injectFindStyles, []);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const cancelPending = useRef<(() => void) | null>(null);

	const units = useMemo(
		() => (open && applied ? findUnits({ native: messages, view: projectView(messages), sideThreads, pendingQuestionVisible: dock }) : []),
		[open, applied, messages, sideThreads, dock],
	);
	const hits = useMemo(() => (applied ? findHits(units, applied) : []), [units, applied]);
	const unitByKey = useMemo(() => new Map(units.map((unit) => [unit.key, unit])), [units]);
	const found = selected === null ? -1 : hits.findIndex((hit) => hitId(hit) === selected);
	const index = hits.length ? Math.max(0, found) : -1;
	const live = useRef({ hits, unitByKey, messages, drawnStart, applied, index, onOpenSideThread });
	live.current = { hits, unitByKey, messages, drawnStart, applied, index, onOpenSideThread };

	const close = useCallback(() => {
		clearSessionFindHighlights();
		cancelPending.current?.();
		setOpen(false);
		if (isInteractionScopeEligible(previousFocus.current, controller)) previousFocus.current!.focus({ preventScroll: true });
	}, [controller]);

	/** Put the hit in view: reveal collapsed text, open a side chat, scroll,
	 *  and flash the whole part when its Nth match cannot be found. */
	const place = useCallback((hit: FindHit, unit: FindUnit) => {
		const { messages: native, applied: text } = live.current;
		const field = collapsedField(unit, unit.blocks[hit.block] ?? "", native);
		if (field) window.dispatchEvent(new CustomEvent("lh:find-reveal", { detail: { key: unit.key, field } }));
		const scope = scopeRef.current;
		if (unit.sideThreadId) {
			live.current.onOpenSideThread?.({ sourceMessageId: unit.sourceMessageId, messageId: unit.sideMessageId });
			const anchor = document.getElementById(messageAnchorId(unit.sourceMessageId))
				?? document.querySelector<HTMLElement>(`[data-source-message-id="${unit.sourceMessageId}"]`);
			if (anchor && scope) scrollSessionTarget(anchor, scope, scrollContextRef.current);
		}
		// The reveal and the side chat commit after this call: look a few frames.
		let attempts = 0;
		const locate = () => {
			const element = partElements(document).get(unit.key);
			if (!element) {
				if (++attempts < 10) requestAnimationFrame(locate);
				return;
			}
			const range = partFindRanges(element, text)[hit.occurrence];
			if (range && scope && !unit.sideThreadId) scrollSessionTarget(range, scope, scrollContextRef.current);
			else if (range) range.startContainer.parentElement?.scrollIntoView?.({ block: "center" });
			if (range) return;
			element.classList.add("lh-source-highlight");
			setTimeout(() => element.classList.remove("lh-source-highlight"), FLASH_MS);
			if (scope && !unit.sideThreadId) scrollSessionTarget(element, scope, scrollContextRef.current);
		};
		requestAnimationFrame(locate);
	}, [scopeRef, scrollContextRef]);

	/** Select a hit and show it; a hit in the earlier history draws back to it first. */
	const show = useCallback((hit: FindHit) => {
		const { unitByKey: byKey, messages: native, drawnStart: start } = live.current;
		const unit = byKey.get(hit.unitKey);
		cancelPending.current?.();
		setSelected(hitId(hit));
		if (!unit) return;
		const at = native.findIndex((m) => m.id === unit.sourceMessageId);
		if (at === -1 || at >= start) { place(hit, unit); return; }
		if (drawStatusNeeded(native, drawnStartForTarget(native, at, start), start)) setDrawing(true);
		const onDrawn = (event: Event) => {
			if ((event as CustomEvent<{ messageId?: string }>).detail?.messageId !== unit.sourceMessageId) return;
			cancelPending.current?.();
			place(hit, unit);
		};
		window.addEventListener("lh:drawn-to-message", onDrawn);
		cancelPending.current = () => {
			window.removeEventListener("lh:drawn-to-message", onDrawn);
			cancelPending.current = null;
			setDrawing(false);
		};
		window.dispatchEvent(new CustomEvent("lh:draw-to-message", { detail: { messageId: unit.sourceMessageId } }));
	}, [place]);

	const step = (direction: 1 | -1) => {
		const next = stepSessionMatch(live.current.index, live.current.hits.length, direction);
		const hit = live.current.hits[next];
		if (hit) show(hit);
	};

	useEffect(() => {
		const onFind = () => {
			if (!isInteractionScopeEligible(scopeRef.current, controller)) return;
			if (!open) previousFocus.current = document.activeElement as HTMLElement | null;
			setOpen(true);
			// A second Mod+F focuses/selects the retained query, not a second dropdown.
			if (open) { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); }
		};
		window.addEventListener(kbdEventForAction("find"), onFind);
		return () => window.removeEventListener(kbdEventForAction("find"), onFind);
	}, [open, controller, scopeRef]);

	useEffect(() => {
		if (!open || !isInteractionScopeEligible(scopeRef.current, controller)) return;
		inputRef.current?.focus({ preventScroll: true });
		inputRef.current?.select();
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || controller?.isEscapeOwned(event) || !isInteractionScopeEligible(scopeRef.current, controller)) return;
			controller?.claimEscape(event);
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	}, [open, close, controller, scopeRef]);

	// Live while typing: the query applies after a short pause, and the newest hit is shown.
	useEffect(() => {
		if (query === applied) return;
		const timer = setTimeout(() => setApplied(query), FIND_PAUSE_MS);
		return () => clearTimeout(timer);
	}, [query, applied]);
	useEffect(() => {
		cancelPending.current?.();
		setSelected(null);
		const newest = live.current.hits[0];
		if (applied && newest) show(newest);
	}, [applied, show]);

	// Highlights: every drawn hit, the selected one strongest. Parts come and
	// go as cards open and history is drawn, so re-place them on DOM changes.
	useEffect(() => {
		if (!open || !applied) return;
		let frame: number | null = null;
		const refresh = () => {
			const { hits: current, unitByKey: byKey, index: selectedIndex } = live.current;
			const parts = partElements(document);
			const ranges = new Map<string, Range[]>();
			const all: Range[] = [];
			for (const [key, element] of parts) {
				const found = partFindRanges(element, applied);
				ranges.set(key, found);
				all.push(...found);
			}
			const hit = current[selectedIndex];
			const unit = hit && byKey.get(hit.unitKey);
			const active = hit && unit ? ranges.get(unit.key)?.[hit.occurrence] : undefined;
			publishHighlights(all, active);
		};
		const schedule = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => { frame = null; refresh(); });
		};
		refresh();
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state", "aria-expanded"] });
		window.addEventListener("resize", schedule);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			if (frame !== null) cancelAnimationFrame(frame);
			clearSessionFindHighlights();
		};
	}, [open, applied, hits, index]);

	useEffect(() => {
		if (!open || index < 0) return;
		listRef.current?.querySelectorAll<HTMLElement>('[data-testid="find-hit"]')[index]?.scrollIntoView?.({ block: "nearest" });
	}, [open, index, hits]);

	// Also clear on a session switch when Find was already closed.
	useEffect(() => () => { cancelPending.current?.(); clearSessionFindHighlights(); }, []);

	const buttonClass = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
	return (
		<div className="lh-no-drag relative shrink-0">
			<button
				type="button"
				data-testid="find-open"
				aria-label="Find in session"
				title="Find in session (⌘F)"
				aria-expanded={open}
				onClick={() => {
					if (open) { close(); return; }
					previousFocus.current = document.activeElement as HTMLElement | null;
					setOpen(true);
				}}
				className="flex size-7 cursor-pointer items-center justify-center rounded-full border border-border/80 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
			>
				<SearchIcon className="size-3.5" aria-hidden />
			</button>
			{open && (
				<div
					role="search"
					aria-label="Session Find"
					data-testid="session-find"
					className="absolute right-0 top-full z-50 mt-2 flex max-h-[65vh] w-[min(28rem,90vw)] flex-col gap-1 rounded-lg border border-border bg-popover p-2 font-ui text-sm text-popover-foreground shadow-lg"
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
							if (event.key === "Enter") event.stopPropagation(); // NEVER reach question/global Enter submits.
							if ((event.target as HTMLElement).tagName !== "INPUT" || event.nativeEvent.isComposing) return;
							event.preventDefault();
							step(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
						} else if (event.key === "Escape") {
							if (!isInteractionScopeEligible(inputRef.current, controller)) return;
							controller?.claimEscape(event);
							event.preventDefault();
							event.stopPropagation();
							close();
						}
					}}
				>
					<div className="flex items-center gap-2">
						<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
						<input
							ref={inputRef}
							aria-label="Find in session"
							placeholder="Find in session…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							// React skips onChange for `input` events on DOMs without `oninput` (test DOMs).
							onInput={(event) => setQuery(event.currentTarget.value)}
							spellCheck={false}
							className="lh-input min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
						/>
						<output aria-live="polite" data-testid="session-find-count" className="shrink-0 text-xs tabular-nums text-muted-foreground">
							{query && query === applied ? `${index + 1}/${hits.length}` : ""}
						</output>
						{" "}
						<button type="button" aria-label="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)" className={buttonClass}
							disabled={!hits.length} onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>
							<ChevronUpIcon className="size-4" aria-hidden />
						</button>
						<button type="button" aria-label="Next match (Enter)" title="Next match (Enter)" className={buttonClass}
							disabled={!hits.length} onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>
							<ChevronDownIcon className="size-4" aria-hidden />
						</button>
						<button type="button" aria-label="Close Find (Esc)" title="Close Find (Esc)" className={buttonClass} onClick={close}>
							<XIcon className="size-4" aria-hidden />
						</button>
					</div>
					{drawing && <div className="px-1 text-xs text-muted-foreground">Drawing earlier history…</div>}
					{applied && (
						<div ref={listRef} data-testid="find-results" className="flex min-h-0 flex-col overflow-y-auto">
							{hits.length === 0 ? (
								<div className="px-1 py-2 text-xs text-muted-foreground">No matches in this session.</div>
							) : hits.map((hit, row) => {
								const unit = unitByKey.get(hit.unitKey);
								return (
									<button
										key={hitId(hit)}
										type="button"
										data-testid="find-hit"
										aria-current={row === index}
										onMouseDown={(event) => event.preventDefault()}
										onClick={() => show(hit)}
										className={`flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent ${row === index ? "bg-accent" : ""}`}
									>
										<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											{unit?.kind}{unit?.unit ? ` · Unit ${unit.unit.index} · ${unit.unit.title}` : ""}
										</span>
										<span className="text-sm text-foreground">
											{hit.snippet.before}<mark className="rounded-sm bg-primary/30 text-inherit">{hit.snippet.match}</mark>{hit.snippet.after}
										</span>
									</button>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
