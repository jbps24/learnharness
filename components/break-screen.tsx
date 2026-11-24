"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useInteractionLayer } from "@/components/interaction-layers";
import { breakCountdown } from "@/src/core";

const BEFORE_ZERO = "Stand up, move, look out of a window. Leave the phone. The lesson waits where you left it.";
const PAST_ZERO = "Time's up. The lesson is waiting where you left it.";
const RADIUS = 90;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The full-screen break (plan 002 part 6): a countdown ring over the lesson.
 *  Continue and Esc are the only ways out. */
export function BreakScreen({
	takenAt,
	lengthMinutes,
	onContinue,
}: {
	takenAt: number;
	lengthMinutes: number;
	onContinue: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, []);

	const rootRef = useRef<HTMLDivElement>(null);
	useInteractionLayer({
		kind: "view", enabled: true, rootRef,
		onClose: () => { onContinue(); return "closed"; },
	});

	if (typeof document === "undefined") return null;
	const { label, over, progress } = breakCountdown(takenAt, lengthMinutes, now);
	return createPortal(
		<div
			ref={rootRef}
			data-testid="break-screen"
			role="dialog"
			aria-modal="true"
			aria-label="Break"
			className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-background px-6 text-center"
		>
			<div className="relative flex size-52 items-center justify-center">
				<svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 200 200" aria-hidden>
					<circle cx="100" cy="100" r={RADIUS} fill="none" strokeWidth="6" className="stroke-border" />
					<circle
						cx="100" cy="100" r={RADIUS} fill="none" strokeWidth="6" strokeLinecap="round"
						className={over ? "stroke-muted-foreground" : "stroke-primary"}
						strokeDasharray={CIRCUMFERENCE}
						strokeDashoffset={CIRCUMFERENCE * progress}
					/>
				</svg>
				<span className="font-ui text-4xl font-medium tabular-nums">{label}</span>
			</div>
			<p className="max-w-sm text-sm text-muted-foreground">{over ? PAST_ZERO : BEFORE_ZERO}</p>
			<Button type="button" onClick={onContinue}>Continue lesson</Button>
		</div>,
		document.body,
	);
}
