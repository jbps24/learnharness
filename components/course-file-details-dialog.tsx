"use client";

import React, { useRef, useState } from "react";
import { HostDialog } from "@/components/host-dialog";
import { fileCategory, fileMaterialKind, filePathLabel } from "@/src/core";
import type { CourseFile, CourseFileStatus, CourseMaterial } from "@/src/core";

export const STATUS_LABEL: Record<CourseFileStatus, string> = {
	pending: "waiting",
	assigning: "reading…",
	assigned: "assigned",
	failed: "failed",
	"not-assignable": "not assignable",
};

export const CONFLICT_TIP = "Your tutor will ask which route your course uses.";
export const RETRY_FAILED_TEXT = "Could not retry. Try again.";
export const REMOVE_FAILED_TEXT = "Could not remove the file. Try again.";
export const RETRY_UNTICKED_TIP = "Tick the file to read it again.";

interface Block {
	key: string;
	title: string;
	pages?: string;
	method: string;
	conflicted: boolean;
	nodeId?: string;
}

function blocksOf(
	file: CourseFile,
	material: CourseMaterial,
	nodes: Array<{ id: string; title: string }>,
	lessonNodes: Array<{ lessonId: string; id: string; title: string }>,
): Block[] {
	if (material.propositionMethods !== undefined) {
		const blocks = new Map<string, Block>();
		for (const m of material.propositionMethods) {
			if (m.path !== file.path) continue;
			const key = `${m.lessonId}\u0000${m.nodeId}\u0000${m.method}`;
			if (blocks.has(key)) continue;
			const title = lessonNodes.find((n) => n.lessonId === m.lessonId && n.id === m.nodeId)?.title ?? "From the lesson";
			blocks.set(key, { key, title, pages: m.pages, method: m.method, conflicted: false });
		}
		return [...blocks.values()];
	}
	const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
	const titleOf = new Map(nodes.map((node) => [node.id, node.title]));
	return material.methods
		.filter((m) => m.path === file.path && titleOf.has(m.nodeId))
		.sort((a, b) => (nodeOrder.get(a.nodeId) ?? 0) - (nodeOrder.get(b.nodeId) ?? 0))
		.map((m) => ({
			key: m.nodeId,
			nodeId: m.nodeId,
			title: titleOf.get(m.nodeId)!,
			pages: m.pages,
			method: m.method,
			conflicted: material.conflicts.some((c) => c.nodeId === m.nodeId && c.chosen === undefined && c.paths.includes(file.path)),
		}));
}

/** An exam file's patterns, grouped per plan node in plan-map order (plan 010 part 4). */
function examGroupsOf(file: CourseFile, material: CourseMaterial, nodes: Array<{ id: string; title: string }>) {
	return nodes
		.map((node) => ({
			node,
			patterns: (material.examPatterns ?? []).filter((p) => p.path === file.path && p.nodeId === node.id),
		}))
		.filter((group) => group.patterns.length > 0);
}

/** A reference file's pointed sections per plan node in plan-map order (plan 012 part 5). */
function referenceGroupsOf(file: CourseFile, material: CourseMaterial, nodes: Array<{ id: string; title: string }>) {
	const sections = material.referenceIndex?.find((r) => r.path === file.path)?.sections ?? [];
	return nodes
		.map((node) => ({
			node,
			sections: (material.referencePointers ?? [])
				.filter((p) => p.path === file.path && p.nodeId === node.id)
				.flatMap((p) => p.sectionIds)
				.map((id) => sections.find((s) => s.id === id))
				.filter((s) => s !== undefined),
		}))
		.filter((group) => group.sections.length > 0);
}

/** An Overview file's book route line for one node (plan 020 part 5): the stored route, a failure, or "reading" while a target is active; null otherwise. */
function bookRouteLine(material: CourseMaterial, file: CourseFile, nodeId: string) {
	if (!file.binding) return null;
	const completePaths = new Set(
		material.files
			.filter((f) => f.binding && fileCategory(f) === "material" && fileMaterialKind(f) !== "overview")
			.map((f) => f.path),
	);
	if (material.methods.some((m) => m.nodeId === nodeId && completePaths.has(m.path))) return null;
	const bindingRefs = new Set(
		material.files
			.filter((f) => f.binding && fileCategory(f) === "reference")
			.map((f) => f.path),
	);
	const routes = (material.bookRoutes ?? []).filter((r) => r.nodeId === nodeId && bindingRefs.has(r.path));
	const stored = routes.find((r) => r.error === undefined && r.method !== "");
	if (stored) return { kind: "stored" as const, route: stored };
	const failed = routes.find((r) => r.error !== undefined);
	if (failed) return { kind: "failed" as const, error: failed.error! };
	const hasActivePointer = (material.referencePointers ?? []).some(
		(p) => p.nodeId === nodeId && p.sectionIds.length > 0 && bindingRefs.has(p.path),
	);
	return hasActivePointer ? { kind: "reading" as const } : null;
}

const CATEGORY_LABEL ={ material: "Course material", exam: "Exams", reference: "Reference" } as const;

/** One file's details (plan 009 part 2): path, status and, once assigned, each
 *  plan node's pages and method text; for an exam file the task patterns
 *  (plan 010 part 4) and the move button. Reads the panel's data; no fetch. */
export function CourseFileDetailsDialog({ file, material, nodes, lessonNodes, onClose, onMove, onMarkKind, onRetry, onRemove, onReplace }: {
	file: CourseFile | null;
	material: CourseMaterial;
	nodes: Array<{ id: string; title: string }>;
	lessonNodes: Array<{ lessonId: string; id: string; title: string }>;
	onClose: () => void;
	onMove?: (file: CourseFile, category: "material" | "exam" | "reference") => void;
	onMarkKind?: (file: CourseFile, kind: "complete" | "overview") => void;
	onRetry?: (file: CourseFile) => Promise<boolean>;
	onRemove?: (file: CourseFile) => Promise<boolean>;
	/** Resolves to the route's error text, or null when the replacement went through. */
	onReplace?: (file: CourseFile, newPath: string) => Promise<string | null>;
}) {
	const [replaceError, setReplaceError] = useState<string | null>(null);
	const replaceInput = useRef<HTMLInputElement>(null);
	const [retryFailed, setRetryFailed] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [removeFailed, setRemoveFailed] = useState(false);
	const [retryPath, setRetryPath] = useState(file?.path);
	if (retryPath !== file?.path) {
		setRetryPath(file?.path);
		setRetryFailed(false);
		setConfirmingRemove(false);
		setRemoveFailed(false);
		setReplaceError(null);
	}
	if (!file) return null;
	const canReplace = Boolean(onReplace) && typeof window !== "undefined" && Boolean(window.lh?.getPathForFile);
	const pickReplacement = async (picked: File | undefined) => {
		const resolve = window.lh?.getPathForFile;
		if (!picked || !resolve || !onReplace) return;
		const path = resolve(picked);
		if (!path) {
			setReplaceError("Could not read the path of that file.");
			return;
		}
		setReplaceError(await onReplace(file, path));
	};
	const update = file.update;
	const titleOf = (nodeId: string) => nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
	const updateGroups = update?.nodes
		? [
			{ label: "Changed route", items: update.nodes.filter((n) => n.kind === "changed").map((n) => ({ key: n.nodeId, title: titleOf(n.nodeId), pages: undefined as string | undefined, pointed: update.revisited.includes(n.nodeId) })) },
			{ label: "Newly covered", items: update.nodes.filter((n) => n.kind === "new").map((n) => ({ key: n.nodeId, title: titleOf(n.nodeId), pages: undefined as string | undefined, pointed: false })) },
			{ label: "No longer covered", items: update.nodes.filter((n) => n.kind === "dropped").map((n) => ({ key: n.nodeId, title: titleOf(n.nodeId), pages: undefined as string | undefined, pointed: false })) },
			{ label: "Sections outside the plan", items: (update.newSections ?? []).map((s) => ({ key: `${s.title}\u0000${s.pages}`, title: s.title, pages: s.pages as string | undefined, pointed: false })) },
		].filter((g) => g.items.length > 0)
		: [];
	const name = filePathLabel(file.path);
	const category = fileCategory(file);
	const isExam = category === "exam";
	const isReference = category === "reference";
	const blocks = file.status === "assigned" && category === "material" ? blocksOf(file, material, nodes, lessonNodes) : [];
	const examGroups = file.status === "assigned" && isExam ? examGroupsOf(file, material, nodes) : [];
	const referenceGroups = file.status === "assigned" && isReference ? referenceGroupsOf(file, material, nodes) : [];
	const isOverview = category === "material" && fileMaterialKind(file) === "overview";
	const toc = isReference ? material.referenceIndex?.find((r) => r.path === file.path) : undefined;
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`Details for ${name}`}
			data-testid="course-file-details-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[70vh] w-[32rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 text-sm shadow-xl"
		>
			<h2 className="text-sm font-semibold">{name}</h2>
			<div className="mt-1 select-text break-all text-xs text-muted-foreground">{file.path}</div>
			<div className="mt-2 text-xs">
				Status: {STATUS_LABEL[file.status]}
				{file.status === "failed" && file.error ? <span className="text-muted-foreground"> — {file.error}</span> : null}
				{file.via === "inherited" && <span className="text-muted-foreground"> · from lesson</span>}
			</div>
			<div className="mt-3 min-h-0 flex-1 overflow-y-auto text-xs">
				{update && category === "material" && (
					<div className="mb-3">
						<p className="text-muted-foreground">
							Replaced {filePathLabel(update.fromPath)} on {new Date(update.at).toLocaleDateString()}.
						</p>
						{file.status === "assigning" && <p className="mt-1 text-muted-foreground">Comparing with the earlier version…</p>}
						{updateGroups.map((g) => (
							<div key={g.label} className="mt-2">
								<div className="font-semibold">{g.label}</div>
								<ul className="mt-1 space-y-0.5">
									{g.items.map((item) => (
										<li key={item.key}>
											<span>{item.title}</span>
											{item.pages && <span className="text-muted-foreground"> {item.pages}</span>}
											{item.pointed && <span className="text-muted-foreground"> · pointed out</span>}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				)}
				{file.status !== "assigned" ? (
					<p className="text-muted-foreground">No plan nodes yet.</p>
				) : isReference ? (
					<>
						{toc && <p className="text-muted-foreground">Table of contents: {toc.sections.length === 1 ? "1 section" : `${toc.sections.length} sections`} (from {toc.from})</p>}
						{referenceGroups.length === 0 ? (
							<p className="mt-2 text-muted-foreground">Not used for any plan node.</p>
						) : (
							<ul className="mt-2 space-y-3">
								{referenceGroups.map(({ node, sections }) => (
									<li key={node.id}>
										<div className="font-semibold">{node.title}</div>
										{sections.map((s) => (
											<div key={s.id} className="mt-1 text-muted-foreground">
												{s.label ? `§${s.label} ` : ""}{s.title} (pp. {s.startPage}–{s.endPage})
											</div>
										))}
										{(material.bookRoutes ?? []).some((r) => r.nodeId === node.id && r.path === file.path && r.error === undefined && r.method !== "") && (
											<div className="mt-1 text-muted-foreground">Book route stored</div>
										)}
									</li>
								))}
							</ul>
						)}
					</>
				) : isExam ? (
						examGroups.length === 0 ? (
							<p className="text-muted-foreground">No task patterns found.</p>
						) : (
							<ul className="space-y-3">
								{examGroups.map(({ node, patterns }) => (
									<li key={node.id}>
										<div className="font-semibold">{node.title}</div>
										{patterns.map((p) => (
											<div key={`${p.source}\u0000${p.pattern}`} className="mt-1">
												<div>
													<span>{p.source}</span>
													{p.pages && <span className="text-muted-foreground"> {p.pages}</span>}
												</div>
												<div className="whitespace-pre-wrap text-muted-foreground">{p.pattern}</div>
												{p.grading && <div className="whitespace-pre-wrap text-muted-foreground">Grading: {p.grading}</div>}
											</div>
										))}
									</li>
								))}
							</ul>
						)
					) : blocks.length === 0 ? (
					<p className="text-muted-foreground">Not used for any plan node.</p>
				) : (
					<>
						<p className="text-muted-foreground">Used for {blocks.length === 1 ? "1 plan node" : `${blocks.length} plan nodes`}:</p>
						<ul className="mt-2 space-y-3">
							{blocks.map((block) => (
								<li key={block.key}>
									<div>
										<span className="font-semibold">{block.title}</span>
										{block.pages && <span className="text-muted-foreground"> {block.pages}</span>}
										{block.conflicted && <span title={CONFLICT_TIP}> ⚠</span>}
									</div>
									<div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{block.method}</div>
									{isOverview && block.nodeId !== undefined && (() => {
										const line = bookRouteLine(material, file, block.nodeId);
										if (!line) return null;
										if (line.kind === "stored") {
											return (
												<div className="mt-1">
													<div>Book route ({filePathLabel(line.route.path)}{line.route.pages ? `, ${line.route.pages}` : ""})</div>
													<div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{line.route.method}</div>
												</div>
											);
										}
										return <div className="mt-1 text-muted-foreground">{line.kind === "failed" ? `Book route failed: ${line.error}` : "Reading the book…"}</div>;
									})()}
								</li>
							))}
						</ul>
					</>
				)}
			</div>
			{confirmingRemove && onRemove ? (
				<div className="mt-4 flex flex-col gap-2">
					<p className="text-xs">Remove {name}? What was read from it is removed too. The file itself stays on your disk.</p>
					{removeFailed && <p className="text-xs text-destructive">{REMOVE_FAILED_TEXT}</p>}
					<div className="flex justify-end gap-2">
						<button type="button"
							onClick={() => void onRemove(file).then((ok) => { if (ok) onClose(); else setRemoveFailed(true); })}
							className="rounded-sm px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10">
							Remove
						</button>
						<button type="button" onClick={() => { setConfirmingRemove(false); setRemoveFailed(false); }}
							className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
							Cancel
						</button>
					</div>
				</div>
			) : (
			<>
			{canReplace && (
				<div className="mt-3 text-xs">
					<input ref={replaceInput} type="file" accept=".pdf,.md,.markdown,.txt,.tex" hidden
						onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ""; void pickReplacement(picked); }} />
					<button type="button" onClick={() => replaceInput.current?.click()}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
						Replace with newer version…
					</button>
					{replaceError && <p className="mt-1 text-destructive">{replaceError}</p>}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				{retryFailed && <span className="mr-auto self-center text-xs text-destructive">{RETRY_FAILED_TEXT}</span>}
				{onRemove && (
					<button type="button" onClick={() => setConfirmingRemove(true)}
						className="rounded-sm px-3 py-1.5 text-xs text-destructive/80 transition-colors hover:text-destructive">
						Remove from list
					</button>
				)}
				{onRetry && file.status === "failed" && (
					<button type="button" disabled={!file.binding}
						title={file.binding ? undefined : RETRY_UNTICKED_TIP}
						onClick={() => void onRetry(file).then((ok) => setRetryFailed(!ok))}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
						Retry
					</button>
				)}
				{onMarkKind && category === "material" && (
					<button type="button" onClick={() => onMarkKind(file, isOverview ? "complete" : "overview")}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
						{isOverview ? "Mark as Complete" : "Mark as Overview"}
					</button>
				)}
				{onMove && (["material", "exam", "reference"] as const).filter((c) => c !== category).map((target) => (
					<button key={target} type="button" onClick={() => onMove(file, target)}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
						Move to {CATEGORY_LABEL[target]}
					</button>
				))}
				<button type="button" onClick={onClose}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
					Close
				</button>
			</div>
			</>
			)}
		</div>
	);
	return (
		<HostDialog open frame={frame} onClose={() => { onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>
			{frame.props.children}
		</HostDialog>
	);
}
