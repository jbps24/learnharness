"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, InfoIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "./server-events.tsx";
import { CONFLICT_TIP, CourseFileDetailsDialog, STATUS_LABEL } from "./course-file-details-dialog.tsx";
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
	].filter((g) => g.group.length > 0);

	const moveFile = async (file: CourseFile, category: "material" | "exam") => {
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
									<span title={file.status === "failed" ? file.error : undefined}
										className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
										{STATUS_LABEL[file.status]}
									</span>
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
				onClose={() => setDetailsPath(null)} onMove={(f, category) => void moveFile(f, category)} />
		</div>
	);
}
