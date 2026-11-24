/**
 * Course material (plan 007).
 *
 * GET   → { material, nodes }: the session's course files, methods and
 *         conflicts (null until the first file is collected) plus the plan
 *         nodes' id/title pairs for naming the methods.
 * PATCH → { path, binding }: the sidebar tick. Changes only `binding`.
 */
import { emit } from "@/src/core";
import { stores } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({
		material: record.courseMaterial ?? null,
		nodes: (record.tree?.nodes ?? []).map((node) => ({ id: node.id, title: node.title })),
	});
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const body = (await request.json().catch(() => null)) as { path?: unknown; binding?: unknown } | null;
	if (!body || typeof body.path !== "string" || typeof body.binding !== "boolean") {
		return Response.json({ error: "Expected { path: string, binding: boolean }" }, { status: 400 });
	}
	const material = record.courseMaterial;
	const target = material?.files.find((file) => file.path === body.path);
	if (!material || !target) return Response.json({ error: "Unknown course file" }, { status: 404 });
	const binding = body.binding;
	stores.chatStore.setCourseMaterial(id, {
		...material,
		files: material.files.map((file) => (file.path === target.path ? { ...file, binding } : file)),
	});
	emit("course-material-changed", { chatId: id });
	return Response.json({ ok: true });
}
