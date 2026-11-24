import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { CourseFile, CourseMaterial } from "../core/contracts/course.ts";

export type CourseFingerprint = NonNullable<CourseFile["fingerprint"]>;

/** Size, mtime and content hash of a course file; null when it cannot be read. */
export async function readFileFingerprint(filePath: string): Promise<CourseFingerprint | null> {
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return null;
		const sha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
		return { size: info.size, mtimeMs: info.mtimeMs, sha256 };
	} catch {
		return null;
	}
}

/** Plan 015: flag a listed file whose content changed on disk under the same
 *  name. A file without a fingerprint gets a baseline and no flag; a touched
 *  file with the same hash is not flagged; a missing file is left alone.
 *  `changed` is true when a flag was newly set. */
export async function detectCourseFileChanges(
	material: CourseMaterial,
): Promise<{ material: CourseMaterial; changed: boolean }> {
	let changed = false;
	let touched = false;
	const files: CourseFile[] = [];
	for (const file of material.files) {
		if (file.status === "pending" || file.status === "assigning" || file.status === "not-assignable" || file.changedOnDisk) {
			files.push(file);
			continue;
		}
		const now = await readFileFingerprint(file.path);
		if (!now) {
			files.push(file);
			continue;
		}
		const before = file.fingerprint;
		if (!before) {
			touched = true;
			files.push({ ...file, fingerprint: now });
		} else if (before.size === now.size && before.mtimeMs === now.mtimeMs) {
			files.push(file);
		} else if (before.sha256 === now.sha256) {
			touched = true;
			files.push({ ...file, fingerprint: now });
		} else {
			changed = true;
			touched = true;
			files.push({ ...file, changedOnDisk: true });
		}
	}
	return { material: touched ? { ...material, files } : material, changed };
}

function sameFingerprint(a: CourseFile["fingerprint"], b: CourseFile["fingerprint"]): boolean {
	if (!a || !b) return a === b;
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
}

/** Merge disk-change results onto the latest stored CourseMaterial without
 *  clobbering concurrent updates (assigned methods, replacements, removals). */
export function mergeDetectedCourseFileChanges(
	fresh: CourseMaterial,
	before: CourseMaterial,
	after: CourseMaterial,
): { material: CourseMaterial; changed: boolean } {
	if (after === before) return { material: fresh, changed: false };
	const patches = new Map<string, { before: CourseFile; after: CourseFile }>();
	for (let i = 0; i < before.files.length; i += 1) {
		const b = before.files[i];
		const a = after.files[i];
		if (b && a && a !== b) patches.set(b.path, { before: b, after: a });
	}
	if (patches.size === 0) return { material: fresh, changed: false };

	let changed = false;
	let touched = false;
	const files = fresh.files.map((file) => {
		const patch = patches.get(file.path);
		if (!patch) return file;
		if (
			file.status === "pending"
			|| file.status === "assigning"
			|| file.status === "not-assignable"
			|| file.changedOnDisk
			|| !sameFingerprint(file.fingerprint, patch.before.fingerprint)
		) {
			return file;
		}
		if (patch.after.changedOnDisk) {
			changed = true;
			touched = true;
			return { ...file, changedOnDisk: true };
		}
		if (patch.after.fingerprint) {
			touched = true;
			return { ...file, fingerprint: patch.after.fingerprint };
		}
		return file;
	});
	return { material: touched ? { ...fresh, files } : fresh, changed };
}
