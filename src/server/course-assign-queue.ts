import {
	applyAssignment,
	type AssignmentResult,
	type AssignmentTarget,
	type AssignmentTargetNode,
	type CourseAssignWorker,
	type ExistingNodeMethod,
} from "../core/course-assign.ts";
import { registerJobAbort, unregisterJobAbort } from "../agent/subagents/aborts.ts";
import type { CourseFileStatus, CourseMaterial } from "../core/contracts/course.ts";
import type { ChatStore, JobStore } from "../core/ports.ts";

export type { CourseAssignWorker, CourseAssignWorkerInput, CourseAssignWorkerResult } from "../core/course-assign.ts";

export interface CourseAssignQueueDeps {
	chatStore: Pick<ChatStore, "getChat" | "setCourseMaterial">;
	jobStore: Pick<JobStore, "createJob" | "updateJob">;
	worker: CourseAssignWorker;
	emit?: (type: "course-material-changed", payload: { chatId: string }) => void;
}

export interface CourseAssignQueue {
	enqueue(chatId: string, targets: readonly AssignmentTarget[]): Promise<void>;
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

	function setStatus(chatId: string, path: string, status: CourseFileStatus, error?: string): void {
		const material = deps.chatStore.getChat(chatId)?.courseMaterial;
		if (!material) return;
		const files = material.files.map((file) => {
			if (file.path !== path) return file;
			const { error: _error, ...rest } = file;
			return { ...rest, status, ...(error !== undefined ? { error } : {}) };
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

		setStatus(chatId, target.path, "assigning");
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
							: { category: "material", nodes: outcome.result.nodes.filter((n) => liveIds.has(n.nodeId)) };
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

	return {
		enqueue(chatId, targets) {
			const previous = tails.get(chatId) ?? Promise.resolve();
			const run = previous.then(async () => {
				for (const target of targets) {
					try {
						await runOne(chatId, target);
					} catch (err) {
						console.error(`[chat ${chatId}] course assignment queue error:`, err);
					}
				}
			});
			tails.set(chatId, run);
			return run;
		},
		cancel(chatId, path) {
			const controller = running.get(runKey(chatId, path));
		if (!controller) return;
		cancelled.add(controller);
		controller.abort();
		},
	};
}
