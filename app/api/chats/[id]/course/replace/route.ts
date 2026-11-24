/**
 * Replace a course file with a newer version (plan 015).
 *
 * POST { path, newPath } → takes the old file's methods as a snapshot, swaps
 *         the listed path for newPath (same path = update in place), cancels a
 *         running read of the old path and reads the new file against all plan
 *         nodes in replace mode. 400 for a malformed body or a newPath that is
 *         missing, a directory or not assignable; 404 for an unknown chat or
 *         path; 409 when newPath is another file already in the list.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { emit, isAssignable, startReplacement } from "@/src/core";
import { assignReplacedCourseFile, cancelCourseFile, resolveSourcePath, stores } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = (await request.json().catch(() => null)) as { path?: unknown; newPath?: unknown } | null;
	if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.path !== "string" || typeof body.newPath !== "string") {
		return Response.json({ error: "Expected { path: string, newPath: string }" }, { status: 400 });
	}
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const oldPath = body.path;
	const material = record.courseMaterial;
	if (!material?.files.some((file) => file.path === oldPath)) return Response.json({ error: "Unknown course file" }, { status: 404 });

	let newPath: string;
	try {
		newPath = resolveSourcePath(body.newPath);
		if (!statSync(newPath).isFile() || !isAssignable(newPath)) throw new Error("not assignable");
	} catch {
		return Response.json({ error: `Not a readable course file: ${body.newPath}` }, { status: 400 });
	}
	if (newPath !== oldPath && material.files.some((file) => file.path === newPath)) {
		return Response.json({ error: `${basename(newPath)} is already in the list.` }, { status: 409 });
	}

	stores.chatStore.setCourseMaterial(id, startReplacement(material, oldPath, newPath, new Date().toISOString()));
	cancelCourseFile(id, oldPath);
	emit("course-material-changed", { chatId: id });
	assignReplacedCourseFile(id, newPath);
	return Response.json({ ok: true });
}
