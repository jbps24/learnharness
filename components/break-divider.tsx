import { Button } from "@/components/ui/button";

export interface BreakDividerData {
	toolCallId: string;
	state: "offered" | "taken" | "skipped" | "ended";
	takenAt?: number;
	lengthMinutes?: number;
	breakMs?: number;
}

const clock = (ms: number) => {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The transcript's break marker (plan 002 part 6): a dashed rule with a chip;
 *  Take/Skip show only while the offer is open. */
export function BreakDivider({
	data,
	busy,
	error,
	onTake,
	onSkip,
}: {
	data: BreakDividerData;
	busy: boolean;
	error?: string;
	onTake: () => void;
	onSkip: () => void;
}) {
	const label =
		data.state === "offered" ? "Short break?"
		: data.state === "skipped" ? "Break skipped"
		: data.state === "taken" ? "On break"
		: `Break · ${clock(data.breakMs ?? 0)}`;
	return (
		<div data-testid="break-divider" className="my-4 flex w-full items-center gap-3">
			<span className="h-0 flex-1 border-t-2 border-dashed border-border/50" aria-hidden />
			<span className="flex flex-col items-center gap-1">
			<span className="flex items-center gap-2 rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
				{data.state === "offered" && (
					<>
						<Button type="button" variant="outline" size="xs" disabled={busy} onClick={onTake}>
							{`Take ${data.lengthMinutes ?? 10} min`}
						</Button>
						<Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onSkip}>
							Skip
						</Button>
					</>
				)}
			</span>
			{data.state === "offered" && error && (
				<span data-testid="break-divider-error" className="text-xs text-destructive">
					{error}
				</span>
			)}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dashed border-border/50" aria-hidden />
		</div>
	);
}
