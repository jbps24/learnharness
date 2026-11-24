/**
 * Course material (plan 007).
 *
 * GET   → { material, nodes, lessonNodes }: the session's course files,
 *         methods and conflicts (null until the first file is collected)
 *         plus the plan nodes' id/title pairs for naming the methods. For a
 *         practice session, lessonNodes names the nodes of the lessons its
 *         inherited proposition methods came from.
 * PATCH → { path, binding }: the sidebar tick. Changes only `binding`.
 *         { path, category }: moves the file between Course material and
 *         Exams (plan 010) or Reference (plan 012); resets it to pending and queues it again.
 *         Both keys in one body: 400.
 */
import { emit, fileCategory } from "@/src/core";
import { assignAddedCourseFiles, stores } from "@/src/server";

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
	const body = (await request.json().catch(() => null)) as { path?: unknown; binding?: unknown; category?: unknown } | null;
	const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
	const hasCategory = isObject && "category" in body;
	const hasBinding = isObject && "binding" in body;
	if (
		!isObject ||
		typeof body.path !== "string" ||
		hasCategory === hasBinding ||
		(hasBinding && typeof body.binding !== "boolean") ||
		(hasCategory && body.category !== "material" && body.category !== "exam" && body.category !== "reference")
	) {
		return Response.json({ error: "Expected { path: string, binding: boolean } or { path: string, category: \"material\" | \"exam\" | \"reference\" }" }, { status: 400 });
	}
	const material = record.courseMaterial;
	const target = material?.files.find((file) => file.path === body.path);
	if (!material || !target) return Response.json({ error: "Unknown course file" }, { status: 404 });
	if (hasCategory) {
		const category = body.category as "material" | "exam" | "reference";
		if (fileCategory(target) === category) return Response.json({ ok: true });
		const conflicts = material.conflicts
			.map(({ chosen, ...conflict }) => ({
				...conflict,
				paths: conflict.paths.filter((p) => p !== target.path),
				...(chosen !== undefined && chosen !== target.path ? { chosen } : {}),
			}))
			.filter((conflict) => conflict.paths.length >= 2);
		const { error: _error, ...rest } = target;
		const { examPatterns, referenceIndex, referencePointers, ...others } = material;
		stores.chatStore.setCourseMaterial(id, {
			...others,
			files: material.files.map((file) => (file.path === target.path ? { ...rest, category, categoryBy: "learner" as const, status: "pending" as const } : file)),
			methods: material.methods.filter((method) => method.path !== target.path),
			conflicts,
			...(examPatterns ? { examPatterns: examPatterns.filter((pattern) => pattern.path !== target.path) } : {}),
			...(referenceIndex ? { referenceIndex: referenceIndex.filter((entry) => entry.path !== target.path) } : {}),
			...(referencePointers ? { referencePointers: referencePointers.filter((pointer) => pointer.path !== target.path) } : {}),
		});
		emit("course-material-changed", { chatId: id });
		assignAddedCourseFiles(id, [target.path]);
		return Response.json({ ok: true });
	}
	const binding = body.binding as boolean;
	stores.chatStore.setCourseMaterial(id, {
		...material,
		files: material.files.map((file) => (file.path === target.path ? { ...file, binding } : file)),
	});
	emit("course-material-changed", { chatId: id });
	return Response.json({ ok: true });
}
