/**
 * Course material (plan 007).
 *
 * GET   → { material, nodes, lessonNodes }: the session's course files,
 *         methods and conflicts (null until the first file is collected)
 *         plus the plan nodes' id/title pairs for naming the methods. For a
 *         practice session, lessonNodes names the nodes of the lessons its
 *         inherited proposition methods came from.
 * PATCH → { path, binding }: the sidebar tick. Changes only `binding`.
 */
import { emit } from "@/src/core";
import { stores } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const lessonNodes: Array<{ lessonId: string; id: string; title: string }> = [];
	const propositionMethods = record.courseMaterial?.propositionMethods ?? [];
	if (record.kind === "practice" && propositionMethods.length > 0) {
		const nodeIdsByLesson = new Map<string, Set<string>>();
		for (const method of propositionMethods) {
			const ids = nodeIdsByLesson.get(method.lessonId) ?? new Set<string>();
			ids.add(method.nodeId);
			nodeIdsByLesson.set(method.lessonId, ids);
		}
		for (const [lessonId, nodeIds] of nodeIdsByLesson) {
			const lesson = stores.chatStore.getChat(lessonId);
			for (const node of lesson?.tree?.nodes ?? []) {
				if (nodeIds.has(node.id)) lessonNodes.push({ lessonId, id: node.id, title: node.title });
			}
		}
	}
	return Response.json({
		material: record.courseMaterial ?? null,
		nodes: (record.tree?.nodes ?? []).map((node) => ({ id: node.id, title: node.title })),
		lessonNodes,
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
