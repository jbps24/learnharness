"use client";

/** Plan 003 part 2: the seam between the earlier history (not drawn) and the
 *  drawn history. Same geometry as the unit cut divider; the two buttons draw
 *  one more budget-step or everything. Excluded from Find. */
export function EarlierHistoryDivider({
	onShowEarlier,
	onShowAll,
}: {
	onShowEarlier: () => void;
	onShowAll: () => void;
}) {
	const button = "rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer";
	return (
		<div data-session-find-exclude="" data-testid="earlier-history-divider" className="my-4 flex w-full items-center gap-3">
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Earlier history
			</span>
			<button type="button" data-testid="earlier-show" className={button} onClick={onShowEarlier}>
				Show earlier
			</button>
			<button type="button" data-testid="earlier-show-all" className={button} onClick={onShowAll}>
				Show all
			</button>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</div>
	);
}
