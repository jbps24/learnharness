import { ASSIGNABLE_EXTENSIONS, type CourseFile, type CourseMaterial } from "./contracts/course.ts";
import { isDirectoryReference, parseFilePaths } from "./file-paths.ts";
import type { LhMessage } from "./native-messages.ts";

export interface FoundCourseFile {
	path: string;
	via: "learner" | "tutor";
}

export function isAssignable(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return ASSIGNABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** core is bundled for the browser, so Node's `os` is only borrowed when present. */
function homeDirectory(): string | null {
	const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
	const os = proc?.getBuiltinModule?.("node:os") as { homedir(): string } | undefined;
	return os?.homedir() ?? null;
}

function isAbsolutePath(candidate: string): boolean {
	return candidate.startsWith("/") || /^[a-z]:[\\/]/i.test(candidate) || candidate.startsWith("\\\\");
}

/** Home-resolve `~/`; anything not absolute afterwards (URLs, relative, `~user`) is null. */
function resolveCoursePath(raw: string): string | null {
	let expanded = raw;
	if (raw.startsWith("~/")) {
		const home = homeDirectory();
		if (home === null) return null;
		const separator = /^[a-z]:[\\/]|^\\\\/i.test(home) ? "\\" : "/";
		expanded = home.replace(/[\\/]+$/, "") + separator + raw.slice(2);
	}
	return isAbsolutePath(expanded) ? expanded : null;
}

export function courseFilesUsed(messages: readonly LhMessage[]): FoundCourseFile[] {
	const found: FoundCourseFile[] = [];
	const seen = new Set<string>();
	const add = (raw: unknown, via: FoundCourseFile["via"]) => {
		if (typeof raw !== "string") return;
		const resolved = resolveCoursePath(raw);
		if (resolved === null || seen.has(resolved)) return;
		seen.add(resolved);
		found.push({ path: resolved, via });
	};
	const addFromText = (text: unknown) => {
		if (typeof text !== "string") return;
		for (const part of parseFilePaths(text)) {
			if (part.kind === "path" && !isDirectoryReference(part.path)) add(part.path, "learner");
		}
	};

	for (const message of messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") addFromText(message.content);
			else for (const block of message.content) if (block.type === "text") addFromText(block.text);
		} else if (message.role === "custom") {
			if (message.customType === "practice-thinking") addFromText(message.content);
		} else if (message.role === "toolResult") {
			if (message.toolName !== "quiz" && message.toolName !== "explain") continue;
			const details = message.details as { text?: unknown; readingThinking?: unknown } | null | undefined;
			addFromText(details?.text);
			addFromText(details?.readingThinking);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const input = block.arguments as { path?: unknown; pdf?: { path?: unknown } | null } | undefined;
				if (block.name === "read" || block.name === "pdf") add(input?.path, "tutor");
				else if (block.name === "visual") add(input?.pdf?.path, "tutor");
			}
		}
	}
	return found;
}

export function mergeCourseFiles(
	existing: CourseMaterial | undefined,
	found: readonly { path: string; via: CourseFile["via"] }[],
	now: string,
): { material: CourseMaterial; added: string[] } {
	const material: CourseMaterial = existing
		? { ...existing, files: [...existing.files] }
		: { files: [], methods: [], conflicts: [] };
	const known = new Set(material.files.map((file) => file.path));
	const added: string[] = [];
	for (const item of found) {
		if (known.has(item.path)) continue;
		known.add(item.path);
		material.files.push({
			path: item.path,
			addedAt: now,
			via: item.via,
			binding: true,
			status: isAssignable(item.path) ? "pending" : "not-assignable",
		});
		added.push(item.path);
	}
	return { material, added };
}
