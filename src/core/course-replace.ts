import { fileCategory } from "./contracts/course.ts";
import type { CourseFile, CourseMaterial, CourseUpdate } from "./contracts/course.ts";

/** Plan 015: begin replacing a course file with a newer version. */
export function startReplacement(
	material: CourseMaterial,
	oldPath: string,
	newPath: string,
	now: string,
): CourseMaterial {
	const old = material.files.find((f) => f.path === oldPath);
	const result: CourseMaterial = {
		...material,
		files: material.files.map((f) => {
			if (f.path !== oldPath) return f;
			const { error: _error, changedOnDisk: _changed, fingerprint: _fingerprint, update: _update, ...kept } = f;
			const next: CourseFile = { ...kept, path: newPath, status: "pending" };
			if (fileCategory(f) === "material") {
				next.update = {
					at: now,
					fromPath: oldPath,
					previous: material.methods
						.filter((m) => m.path === oldPath)
						.map((m) => (m.pages === undefined
							? { nodeId: m.nodeId, method: m.method }
							: { nodeId: m.nodeId, pages: m.pages, method: m.method })),
					revisited: [],
					planAsked: false,
				};
			}
			return next;
		}),
		methods: material.methods.filter((m) => m.path !== oldPath),
		conflicts: material.conflicts.map((c) => ({
			...c,
			paths: c.paths.map((p) => (p === oldPath ? newPath : p)),
			...(c.chosen === oldPath ? { chosen: newPath } : {}),
		})),
	};
	if (!old) return material;
	if (material.examPatterns) result.examPatterns = material.examPatterns.filter((p) => p.path !== oldPath);
	if (material.referenceIndex) result.referenceIndex = material.referenceIndex.filter((r) => r.path !== oldPath);
	if (material.referencePointers) result.referencePointers = material.referencePointers.filter((r) => r.path !== oldPath);
	return result;
}

/** Plan 015: classify plan nodes across previous and new course methods. */
export function classifyUpdate(
	previous: CourseUpdate["previous"],
	newMethods: ReadonlyArray<{ nodeId: string; pages?: string; method: string }>,
	sameAsPrevious: Record<string, boolean>,
): CourseUpdate["nodes"] {
	const newIds = new Set(newMethods.map((m) => m.nodeId));
	const prevIds = new Set(previous.map((m) => m.nodeId));
	const nodes: NonNullable<CourseUpdate["nodes"]> = [];
	for (const p of previous) {
		if (!newIds.has(p.nodeId)) nodes.push({ nodeId: p.nodeId, kind: "dropped" });
		else nodes.push({ nodeId: p.nodeId, kind: sameAsPrevious[p.nodeId] ? "same" : "changed" });
	}
	for (const m of newMethods) {
		if (!prevIds.has(m.nodeId)) nodes.push({ nodeId: m.nodeId, kind: "new" });
	}
	return nodes;
}
