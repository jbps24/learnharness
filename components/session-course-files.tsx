"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, InfoIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "./server-events.tsx";
import { usePopoverDismiss } from "./popover-dismiss.ts";
import {
	CONFLICT_TIP, CourseFileDetailsDialog, RETRY_FAILED_TEXT, RETRY_UNTICKED_TIP, STATUS_LABEL,
} from "./course-file-details-dialog.tsx";
import { fileCategory, filePathLabel } from "@/src/core";
import type { CourseFile, CourseMaterial } from "@/src/core";

interface CourseResponse {
	material: CourseMaterial | null;
	nodes: Array<{ id: string; title: string }>;
	lessonNodes?: Array<{ lessonId: string; id: string; title: string }>;
}

const openKey = (chatId: string) => `lh:course-files-open:${chatId}`;

function readOpen(chatId: string): boolean {
	try {
		return localStorage.getItem(openKey(chatId)) === "1";
	} catch {
		return false;
	}
}

function writeOpen(chatId: string, open: boolean) {
	try {
		localStorage.setItem(openKey(chatId), open ? "1" : "0");
	} catch {
		/* storage unavailable: the state still works for this mount */
	}
}

/** A failed file's status chip: a button opening a popover with the error and Retry (plan 013 part 2). */
function FailedChip({ file, binding, onRetry }: {
	file: CourseFile;
	binding: boolean;
	onRetry: (file: CourseFile) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const [failed, setFailed] = useState(false);
	const rootRef = useRef<HTMLSpanElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(rootRef, open, close, { layerRootRef: panelRef });

	const retry = async () => {
		const ok = await onRetry(file);
		setFailed(!ok);
		if (ok) setOpen(false);
	};

	return (
		<span ref={rootRef} className="relative shrink-0">
			<button type="button" aria-haspopup="dialog" aria-expanded={open} title={file.error}
				onClick={() => { if (!open) setFailed(false); setOpen(!open); }}
				className="rounded bg-muted px-1 text-muted-foreground hover:underline">
				{STATUS_LABEL[file.status]}
			</button>
			{open && (
				<div ref={panelRef} role="dialog"
					className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border bg-card p-2 text-xs shadow-md">
					<p className="break-words">{file.error ?? "Reading failed."}</p>
					{failed && <p className="mt-1 text-destructive">{RETRY_FAILED_TEXT}</p>}
					<button type="button" onClick={() => void retry()} disabled={!binding}
						title={binding ? undefined : RETRY_UNTICKED_TIP}
						className="mt-2 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
						Retry
					</button>
				</div>
			)}
		</span>
	);
}

/** A file changed on disk: a chip button opening a popover with Update (plan 015 part 4). */
function ChangedChip({ file, onUpdate }: {
	file: CourseFile;
	onUpdate: (file: CourseFile) => Promise<string | null>;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLSpanElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(rootRef, open, close, { layerRootRef: panelRef });

	const update = async () => {
		const failure = await onUpdate(file);
		setError(failure);
		if (!failure) setOpen(false);
	};

	return (
		<span ref={rootRef} className="relative shrink-0">
			<button type="button" aria-haspopup="dialog" aria-expanded={open}
				onClick={() => { if (!open) setError(null); setOpen(!open); }}
				className="rounded bg-muted px-1 text-muted-foreground hover:underline">
				changed
			</button>
			{open && (
				<div ref={panelRef} role="dialog"
					className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border bg-card p-2 text-xs shadow-md">
					<p className="break-words">This file changed on disk since it was read.</p>
					{error && <p className="mt-1 text-destructive">{error}</p>}
					<button type="button" onClick={() => void update()}
						className="mt-2 rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:text-foreground">
						Update
					</button>
				</div>
			)}
		</span>
	);
}

/** The open session's course files (plan 007 part 7): tick, status,
 *  unresolved-conflict marks, and a details dialog per file (plan 009). */
export function SessionCourseFiles({ chatId, active }: { chatId: string; active: boolean }) {
	const [data, setData] = useState<CourseResponse | null>(null);
	const [open, setOpen] = useState(() => readOpen(chatId));
	const [overrides, setOverrides] = useState<Record<string, boolean>>({});
	const [hint, setHint] = useState<string | null>(null);
	const [detailsPath, setDetailsPath] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/course`);
			if (!res.ok) return;
			const next = (await res.json()) as CourseResponse;
			setOverrides({});
			setData(next);
			setDetailsPath((current) => (current && !next.material?.files.some((f) => f.path === current) ? null : current));
		} catch {
			/* keep the last list */
		}
	}, [chatId]);

	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;

	const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(hintTimer.current), []);

	useEffect(() => {
		if (active) void refresh();
	}, [active, refresh]);
	useServerEvent("course-material-changed", (payload) => {
		if (active && payload.chatId === chatId) void refreshRef.current();
	});
	useServerResync(() => {
		if (active) void refreshRef.current();
	});

	if (!active || !data?.material || data.material.files.length === 0) return null;
	const { files, methods, conflicts } = data.material;
	const ordered = [...files].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
	const groups = [
		{ label: "Course material", group: ordered.filter((f) => fileCategory(f) === "material") },
		{ label: "Exams", group: ordered.filter((f) => fileCategory(f) === "exam") },
		{ label: "Reference", group: ordered.filter((f) => fileCategory(f) === "reference") },
	].filter((g) => g.group.length > 0);

	const moveFile = async (file: CourseFile, category: "material" | "exam" | "reference") => {
		try {
			await fetch(`/api/chats/${chatId}/course`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: file.path, category }),
			});
		} catch {
			/* the list stays as it was; the re-read event updates it on success */
		}
	};

	const retryFile = async (file: CourseFile): Promise<boolean> => {
		try {
			const res = await fetch(`/api/chats/${chatId}/course`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: file.path, retry: true }),
			});
			return res.ok;
		} catch {
			return false;
		}
	};

	const removeFile = async (file: CourseFile): Promise<boolean> => {
		try {
			const res = await fetch(`/api/chats/${chatId}/course`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: file.path }),
			});
			return res.ok;
		} catch {
			return false;
		}
	};

	/** Replaces a file with a newer version; returns the route's error text, or null on success. */
	const replaceFile = async (file: CourseFile, newPath: string): Promise<string | null> => {
		try {
			const res = await fetch(`/api/chats/${chatId}/course/replace`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: file.path, newPath }),
			});
			if (res.ok) return null;
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			return body?.error ?? "Could not replace the file. Try again.";
		} catch {
			return "Could not replace the file. Try again.";
		}
	};

	const toggleOpen = () => {
		const next = !open;
		setOpen(next);
		writeOpen(chatId, next);
	};

	const setBinding = async (file: CourseFile, binding: boolean) => {
		const previous = overrides[file.path] ?? file.binding;
		setOverrides((current) => ({ ...current, [file.path]: binding }));
		let ok = false;
		try {
			const res = await fetch(`/api/chats/${chatId}/course`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: file.path, binding }),
			});
			ok = res.ok;
		} catch {
			ok = false;
		}
		if (!ok) setOverrides((current) => ({ ...current, [file.path]: previous }));
	};

	const openFile = async (file: CourseFile) => {
		const bridge = window.lh?.openCourseFile;
		if (bridge) {
			await bridge(chatId, file.path);
			return;
		}
		try {
			await navigator.clipboard.writeText(file.path);
			setHint("Path copied");
		} catch {
			setHint("Could not copy the path");
		}
		clearTimeout(hintTimer.current);
		hintTimer.current = setTimeout(() => setHint(null), 2000);
	};

	return (
		<div className="pl-6 pr-2 pb-1 text-xs" data-testid="session-course-files">
			<button type="button" onClick={toggleOpen} aria-expanded={open}
				className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
				{open ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
				<span>Files ({files.length})</span>
			</button>
			{open && (
				<div className="mt-1 space-y-2">
					{groups.map(({ label, group }) => (
					<div key={label}>
					<div className="font-medium text-muted-foreground">{label}</div>
					<ul className="mt-1 space-y-1">
					{group.map((file) => {
						const binding = overrides[file.path] ?? file.binding;
						const conflicted = conflicts.some((c) => c.chosen === undefined && c.paths.includes(file.path)
							&& methods.some((m) => m.path === file.path && m.nodeId === c.nodeId));
						return (
							<li key={file.path} className={binding ? undefined : "opacity-50"}>
								<div className="flex items-center gap-1.5">
									<input type="checkbox" checked={binding} onChange={() => void setBinding(file, !binding)}
										aria-label={`Use ${filePathLabel(file.path)} as a course file`} />
									<button type="button" title={file.path} onClick={() => void openFile(file)}
										className="min-w-0 truncate text-left hover:underline">
										{filePathLabel(file.path)}
									</button>
									{file.changedOnDisk ? (
										<ChangedChip file={file} onUpdate={(f) => replaceFile(f, f.path)} />
									) : file.status === "failed" ? (
										<FailedChip file={file} binding={binding} onRetry={retryFile} />
									) : (
										<span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
											{STATUS_LABEL[file.status]}
										</span>
									)}
									{file.via === "inherited" && <span className="shrink-0 text-muted-foreground">from lesson</span>}
									{conflicted && <span title={CONFLICT_TIP} className="shrink-0">⚠</span>}
									<button type="button" data-testid="course-file-details"
										aria-label={`Details for ${filePathLabel(file.path)}`}
										onClick={() => setDetailsPath(file.path)}
										className="shrink-0 text-muted-foreground hover:text-foreground">
										<InfoIcon className="size-3" aria-hidden="true" />
									</button>
								</div>
							</li>
						);
					})}
					</ul>
					</div>
					))}
				</div>
			)}
			{hint && <div className="mt-1 text-muted-foreground">{hint}</div>}
			<CourseFileDetailsDialog file={files.find((f) => f.path === detailsPath) ?? null}
				material={data.material} nodes={data.nodes} lessonNodes={data.lessonNodes ?? []}
				onClose={() => setDetailsPath(null)} onMove={(f, category) => void moveFile(f, category)} onRetry={retryFile} onRemove={removeFile} onReplace={replaceFile} />
		</div>
	);
}
