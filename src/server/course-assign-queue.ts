import { basename } from "node:path";
import {
	applyAssignment,
	applyMaterialKind,
	type AssignmentResult,
	type AssignmentTarget,
	type AssignmentTargetNode,
	type CourseAssignWorker,
	type CourseLabelWorker,
	type ExistingNodeMethod,
} from "../core/course-assign.ts";
import { registerJobAbort, unregisterJobAbort } from "../agent/subagents/aborts.ts";
import { bookRouteTargets, overviewMethodsOf, type BookRouteTarget, type BookRouteWorker } from "../core/book-routes.ts";
import type { BookRoute, CourseFileStatus, CourseMaterial } from "../core/contracts/course.ts";
import type { ChatStore, JobStore } from "../core/ports.ts";
import { readFileFingerprint, type CourseFingerprint } from "./course-fingerprint.ts";

export type { CourseAssignWorker, CourseAssignWorkerInput, CourseAssignWorkerResult } from "../core/course-assign.ts";

export interface CourseAssignQueueDeps {
	chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial">;
	jobStore: Pick<JobStore, "createJob" | "updateJob">;
	worker: CourseAssignWorker;
	labelWorker?: CourseLabelWorker;
	bookRouteWorker?: BookRouteWorker;
	emit?: (type: "course-material-changed", payload: { chatId: string }) => void;
}

export interface CourseAssignQueue {
	enqueue(chatId: string, targets: readonly AssignmentTarget[]): Promise<void>;
	enqueueLabel(chatId: string, paths: readonly string[]): Promise<void>;
	enqueueBookRoutes(chatId: string, targets: readonly BookRouteTarget[]): Promise<void>;
	/** Prune stale book routes and read the missing ones (plan 020 part 3 triggers). */
	syncBookRoutes(chatId: string): Promise<void>;
	cancel(chatId: string, path: string): void;
}

const INTERRUPTED = "Assignment was interrupted.";
const REMOVED = "Removed from the list.";

/** One serial queue per chat (plan 007 part 3). `enqueue` resolves once its
 *  own jobs have run; jobs from separate calls run one at a time, in order. */
export function createCourseAssignQueue(deps: CourseAssignQueueDeps): CourseAssignQueue {
	const tails = new Map<string, Promise<void>>();
	const running = new Map<string, AbortController>();
	const runKey = (chatId: string, path: string) => `${chatId}\0${path}`;
	const cancelled = new WeakSet<AbortController>();
	let jobSeq = 0;

	function setStatus(chatId: string, path: string, status: CourseFileStatus, error?: string, fingerprint?: CourseFingerprint | null): void {
		const material = deps.chatStore.getChat(chatId)?.courseMaterial;
		if (!material) return;
		const files = material.files.map((file) => {
			if (file.path !== path) return file;
			const { error: _error, changedOnDisk: _changed, ...rest } = file;
			return {
				...rest,
				...(fingerprint ? { fingerprint } : {}),
				...(fingerprint === undefined && file.changedOnDisk ? { changedOnDisk: true } : {}),
				status,
				...(error !== undefined ? { error } : {}),
			};
		});
		deps.chatStore.setCourseMaterial(chatId, { ...material, files });
		deps.emit?.("course-material-changed", { chatId });
	}

	function save(chatId: string, material: CourseMaterial): void {
		deps.chatStore.setCourseMaterial(chatId, material);
		deps.emit?.("course-material-changed", { chatId });
	}

	/** Plan 014: the learner removed the file from the list. */
	function isRemoved(chatId: string, path: string): boolean {
		const material = deps.chatStore.getChat(chatId)?.courseMaterial;
		return !material?.files.some((f) => f.path === path);
	}

	function discardRemoved(jobId: string): void {
		deps.jobStore.updateJob(jobId, { status: "error", error: REMOVED, activity: "failed" });
	}

	async function runOne(chatId: string, target: AssignmentTarget): Promise<void> {
		const chat = deps.chatStore.getChat(chatId);
		const material = chat?.courseMaterial;
		const tree = chat?.tree;
		const file = material?.files.find((f) => f.path === target.path);
		if (!chat || !material || !tree || !file || file.status === "not-assignable") return;

		const wanted = new Set(target.nodeIds);
		const nodes = tree.nodes.filter((node) => wanted.has(node.id));
		if (nodes.length === 0) return;
		const targets: AssignmentTargetNode[] = nodes.map((node) => {
			const unit = tree.units?.find((u) => u.nodeIds.includes(node.id));
			return {
				id: node.id,
				title: node.title,
				...(node.summary ? { summary: node.summary } : {}),
				...(unit ? { unitTitle: unit.title, ...(unit.source ? { unitSource: unit.source } : {}) } : {}),
			};
		});
		const binding = new Set(material.files.filter((f) => f.binding && f.path !== target.path).map((f) => f.path));
		const existingMethods: Record<string, ExistingNodeMethod[]> = {};
		for (const m of material.methods) {
			if (!wanted.has(m.nodeId) || !binding.has(m.path)) continue;
			(existingMethods[m.nodeId] ??= []).push({ path: m.path, method: m.method });
		}

		// Plan 015: the fingerprint is stored when the read starts and clears a changed-on-disk flag.
		setStatus(chatId, target.path, "assigning", undefined, await readFileFingerprint(target.path));
		const previousMethods: Record<string, { pages?: string; method: string }> = {};
		for (const p of target.replace ? (file.update?.previous ?? []) : []) {
			if (wanted.has(p.nodeId)) previousMethods[p.nodeId] = p.pages === undefined ? { method: p.method } : { pages: p.pages, method: p.method };
		}
		const job = deps.jobStore.createJob({
			// A core kind keeps the dock's rendering; nothing runs it through the job runner.
			kind: "pdf",
			chatId,
			toolCallId: `course-assign:${++jobSeq}:${target.path}`,
			activity: `assigning ${target.path}`,
			input: { path: target.path, nodeIds: targets.map((t) => t.id) },
		});

		const controller = new AbortController();
		const key = runKey(chatId, target.path);
		const gone = () => cancelled.has(controller) || isRemoved(chatId, target.path);
		running.set(key, controller);
		registerJobAbort(job.id, controller);
		try {
			const stored = material.referenceIndex?.find((entry) => entry.path === target.path);
			const category =
				file.categoryBy === "learner" && (file.category === "material" || file.category === "exam" || file.category === "reference")
					? file.category
					: file.category === "reference" && stored
						? "reference"
						: undefined;
			const outcome = await deps.worker({
				chatId,
				path: target.path,
				targets,
				existingMethods,
				...(target.replace ? { previousMethods } : {}),
				...(category ? { category } : {}),
				...(file.category === "reference" && stored ? { referenceIndex: { from: stored.from, sections: stored.sections } } : {}),
				abortSignal: controller.signal,
			});
			if (gone()) {
				discardRemoved(job.id);
				return;
			}
			if (controller.signal.aborted) throw new Error("aborted");
			if (outcome.ok) {
				const freshChat = deps.chatStore.getChat(chatId);
				const current = freshChat?.courseMaterial;
				if (!current) throw new Error("course material is gone");
				const liveIds = new Set((freshChat.tree?.nodes ?? []).map((n) => n.id));
				const filtered: AssignmentResult =
					outcome.result.category === "exam"
						? { category: "exam", nodes: outcome.result.nodes.filter((n) => liveIds.has(n.nodeId)) }
						: outcome.result.category === "reference"
							? { ...outcome.result, nodes: outcome.result.nodes.filter((n) => liveIds.has(n.nodeId)) }
							: { ...outcome.result, nodes: outcome.result.nodes.filter((n) => liveIds.has(n.nodeId)) };
				const currentFile = current.files.find((f) => f.path === target.path);
				if (
					currentFile?.categoryBy === "learner" &&
					currentFile.category !== undefined &&
					currentFile.category !== filtered.category
				) {
					console.warn(
						`[chat ${chatId}] course assignment of ${target.path}: the reader answered ${filtered.category}, the learner set ${currentFile.category}; answer ignored`,
					);
				}
				if (
					filtered.category === "material" &&
					currentFile?.materialKindBy === "learner" &&
					currentFile.materialKind !== undefined &&
					filtered.materialKind !== undefined &&
					currentFile.materialKind !== filtered.materialKind
				) {
					console.warn(
						`[chat ${chatId}] course assignment of ${target.path}: the reader answered ${filtered.materialKind}, the learner set ${currentFile.materialKind}; answer ignored`,
					);
				}
				save(chatId, applyAssignment(current, target.path, filtered, targets.map((t) => t.id)));
				deps.jobStore.updateJob(job.id, { status: "done", activity: "assigned" });
			} else {
				setStatus(chatId, target.path, "failed", outcome.error);
				deps.jobStore.updateJob(job.id, { status: "error", error: outcome.error, activity: "failed" });
			}
		} catch (err) {
			if (gone()) {
				discardRemoved(job.id);
				return;
			}
			console.error(`[chat ${chatId}] course assignment of ${target.path} failed:`, err);
			setStatus(chatId, target.path, "failed", INTERRUPTED);
			deps.jobStore.updateJob(job.id, { status: "error", error: INTERRUPTED, activity: "failed" });
		} finally {
			running.delete(key);
			unregisterJobAbort(job.id);
		}
	}

	/** Plan 020 part 2: label one material file Complete or Overview; a failure leaves the field absent. */
	async function runLabel(chatId: string, path: string): Promise<void> {
		const file = deps.chatStore.getChat(chatId)?.courseMaterial?.files.find((f) => f.path === path);
		if (!deps.labelWorker || !file || file.status !== "assigned" || file.materialKind !== undefined) return;
		const job = deps.jobStore.createJob({
			kind: "pdf",
			chatId,
			toolCallId: `course-label:${++jobSeq}:${path}`,
			activity: `Checking ${basename(path)}`,
			input: { path },
		});
		const controller = new AbortController();
		const key = runKey(chatId, path);
		running.set(key, controller);
		registerJobAbort(job.id, controller);
		try {
			const outcome = await deps.labelWorker({ chatId, path, abortSignal: controller.signal });
			if (cancelled.has(controller) || isRemoved(chatId, path)) {
				discardRemoved(job.id);
				return;
			}
			if (outcome.ok) {
				const current = deps.chatStore.getChat(chatId)?.courseMaterial;
				if (!current) throw new Error("course material is gone");
				save(chatId, applyMaterialKind(current, path, outcome.materialKind));
				deps.jobStore.updateJob(job.id, { status: "done" });
			} else {
				console.warn(`[chat ${chatId}] course label of ${path} failed: ${outcome.error}`);
				deps.jobStore.updateJob(job.id, { status: "error", error: outcome.error, activity: "failed" });
			}
		} catch (err) {
			if (cancelled.has(controller) || isRemoved(chatId, path)) {
				discardRemoved(job.id);
				return;
			}
			console.error(`[chat ${chatId}] course label of ${path} failed:`, err);
			deps.jobStore.updateJob(job.id, { status: "error", error: INTERRUPTED, activity: "failed" });
		} finally {
			running.delete(key);
			unregisterJobAbort(job.id);
		}
	}

	/** Plan 020 part 3: read one book route; the result is stored as a BookRoute, failed ones with their error. */
	async function runBookRoute(chatId: string, target: BookRouteTarget): Promise<void> {
		const chat = deps.chatStore.getChat(chatId);
		const material = chat?.courseMaterial;
		const node = chat?.tree?.nodes.find((n) => n.id === target.nodeId);
		const index = material?.referenceIndex?.find((entry) => entry.path === target.path);
		if (!deps.bookRouteWorker || !chat || !material || !node || !index || isRemoved(chatId, target.path)) return;

		const job = deps.jobStore.createJob({
			kind: "pdf",
			chatId,
			toolCallId: `book-route:${++jobSeq}:${target.path}:${target.nodeId}`,
			activity: `Reading ${basename(target.path)} for ${node.title}`,
			input: { path: target.path, nodeIds: [node.id] },
		});
		const controller = new AbortController();
		const key = runKey(chatId, target.path);
		const gone = () => {
			const fresh = deps.chatStore.getChat(chatId);
			return cancelled.has(controller) || isRemoved(chatId, target.path) || !fresh?.tree?.nodes.some((n) => n.id === target.nodeId);
		};
		const store = (route: BookRoute) => {
			const current = deps.chatStore.getChat(chatId)?.courseMaterial;
			if (!current) throw new Error("course material is gone");
			const others = (current.bookRoutes ?? []).filter((r) => !(r.nodeId === route.nodeId && r.path === route.path));
			save(chatId, { ...current, bookRoutes: [...others, route] });
		};
		running.set(key, controller);
		registerJobAbort(job.id, controller);
		try {
			const outcome = await deps.bookRouteWorker({
				chatId,
				nodeId: node.id,
				nodeTitle: node.title,
				...(node.summary ? { nodeSummary: node.summary } : {}),
				path: target.path,
				sectionIds: target.sectionIds,
				sections: index.sections,
				referenceFrom: index.from,
				overviewMethods: overviewMethodsOf(material, node.id),
				abortSignal: controller.signal,
			});
			if (gone()) {
				discardRemoved(job.id);
				return;
			}
			if (controller.signal.aborted) throw new Error("aborted");
			if (outcome.ok) {
				store({ nodeId: target.nodeId, path: target.path, sectionIds: target.sectionIds, pages: outcome.pages, method: outcome.method });
				deps.jobStore.updateJob(job.id, { status: "done" });
			} else {
				store({ nodeId: target.nodeId, path: target.path, sectionIds: target.sectionIds, pages: "", method: "", error: outcome.error });
				deps.jobStore.updateJob(job.id, { status: "error", error: outcome.error, activity: "failed" });
			}
		} catch (err) {
			if (gone()) {
				discardRemoved(job.id);
				return;
			}
			console.error(`[chat ${chatId}] book route of ${target.path} for ${target.nodeId} failed:`, err);
			store({ nodeId: target.nodeId, path: target.path, sectionIds: target.sectionIds, pages: "", method: "", error: INTERRUPTED });
			deps.jobStore.updateJob(job.id, { status: "error", error: INTERRUPTED, activity: "failed" });
		} finally {
			running.delete(key);
			unregisterJobAbort(job.id);
		}
	}

	const bookKey = (chatId: string, t: BookRouteTarget) => `${chatId}\0${t.nodeId}\0${t.path}`;
	/** Targets queued or running; a target is never enqueued twice. */
	const bookPending = new Set<string>();

	/** Run claimed targets one at a time. Runs inside the chat's tail. */
	async function runBookRoutes(chatId: string, targets: readonly BookRouteTarget[]): Promise<void> {
		for (const target of targets) {
			try {
				await runBookRoute(chatId, target);
			} catch (err) {
				console.error(`[chat ${chatId}] book route queue error:`, err);
			} finally {
				bookPending.delete(bookKey(chatId, target));
			}
		}
	}

	function claim(chatId: string, targets: readonly BookRouteTarget[]): BookRouteTarget[] {
		const claimed: BookRouteTarget[] = [];
		for (const target of targets) {
			const key = bookKey(chatId, target);
			if (bookPending.has(key)) continue;
			bookPending.add(key);
			claimed.push(target);
		}
		return claimed;
	}

	/** Compute the due set, remove stale routes and read what is missing. Runs inside the chat's tail. */
	async function syncBookRoutes(chatId: string): Promise<void> {
		if (!deps.bookRouteWorker) return;
		const chat = deps.chatStore.getChat(chatId);
		if (!chat?.courseMaterial || !chat.tree) return;
		const { targets, material } = bookRouteTargets(chat.courseMaterial, chat.tree);
		if (material !== chat.courseMaterial) save(chatId, material);
		await runBookRoutes(chatId, claim(chatId, targets));
	}

	function chain(chatId: string, work: () => Promise<void>): Promise<void> {
		const previous = tails.get(chatId) ?? Promise.resolve();
		const run = previous.then(work);
		tails.set(chatId, run);
		return run;
	}

	return {
		enqueue(chatId, targets) {
			return chain(chatId, async () => {
				for (const target of targets) {
					try {
						await runOne(chatId, target);
					} catch (err) {
						console.error(`[chat ${chatId}] course assignment queue error:`, err);
					}
					await syncBookRoutes(chatId).catch((err) => console.error(`[chat ${chatId}] book route sync error:`, err));
				}
			});
		},
		enqueueLabel(chatId, paths) {
			return chain(chatId, async () => {
				for (const path of paths) {
					try {
						await runLabel(chatId, path);
					} catch (err) {
						console.error(`[chat ${chatId}] course label queue error:`, err);
					}
					await syncBookRoutes(chatId).catch((err) => console.error(`[chat ${chatId}] book route sync error:`, err));
				}
			});
		},
		enqueueBookRoutes(chatId, targets) {
			const claimed = claim(chatId, targets);
			return chain(chatId, () => runBookRoutes(chatId, claimed));
		},
		syncBookRoutes(chatId) {
			return chain(chatId, () => syncBookRoutes(chatId));
		},
		cancel(chatId, path) {
			const controller = running.get(runKey(chatId, path));
		if (!controller) return;
		cancelled.add(controller);
		controller.abort();
		},
	};
}
