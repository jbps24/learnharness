/**
 * Course material (plan 007).
 *
 * GET   → { material, nodes, lessonNodes }: the session's course files,
 *         methods and conflicts (null until the first file is collected)
 *         plus the plan nodes' id/title pairs for naming the methods. Plan 015:
 *         first flags a file whose content changed on disk (changedOnDisk). For a
 *         practice session, lessonNodes names the nodes of the lessons its
 *         inherited proposition methods came from.
 * PATCH → { path, binding }: the sidebar tick. Changes only `binding`.
 *         { path, category }: moves the file between Course material and
 *         Exams (plan 010) or Reference (plan 012); resets it to pending and queues it again.
 *         { path, retry: true }: plan 013. Sets a failed, ticked file back to
 *         pending (error removed) and queues it again; 409 if it is not
 *         failed or not ticked.
 *         { path, materialKind }: plan 020. Labels a material file Complete or
 *         Overview (materialKindBy: "learner"); does not re-read the file; a
 *         file that is not material: 400.
 *         More than one of binding, category, retry, materialKind in one body: 400.
 * DELETE → { path }: plan 014. Removes the file and every stored entry that
 *         names it, and cancels its queued or running assignment; 400 for a
 *         malformed body, 404 for an unknown chat or path.
 */
import { clearFailedBookRoutes, emit, fileCategory, fileMaterialKind, removeCourseFile } from "@/src/core";
import { assignAddedCourseFiles, assignReplacedCourseFile, cancelCourseFile, refreshCourseFileChanges, stores, syncBookRoutes } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	// Plan 015: a file whose content changed on disk under the same name is flagged.
	const courseMaterial = await refreshCourseFileChanges(id);
	const lessonNodes: Array<{ lessonId: string; id: string; title: string }> = [];
	const propositionMethods = courseMaterial?.propositionMethods ?? [];
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
		material: courseMaterial ?? null,
		nodes: (record.tree?.nodes ?? []).map((node) => ({ id: node.id, title: node.title })),
		lessonNodes,
	});
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const body = (await request.json().catch(() => null)) as { path?: unknown; binding?: unknown; category?: unknown; retry?: unknown; materialKind?: unknown } | null;
	const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
	const hasCategory = isObject && "category" in body;
	const hasBinding = isObject && "binding" in body;
	const hasRetry = isObject && "retry" in body;
	const hasMaterialKind = isObject && "materialKind" in body;
	if (
		!isObject ||
		typeof body.path !== "string" ||
		Number(hasCategory) + Number(hasBinding) + Number(hasRetry) + Number(hasMaterialKind) !== 1 ||
		(hasBinding && typeof body.binding !== "boolean") ||
		(hasRetry && body.retry !== true) ||
		(hasMaterialKind && body.materialKind !== "complete" && body.materialKind !== "overview") ||
		(hasCategory && body.category !== "material" && body.category !== "exam" && body.category !== "reference")
	) {
		return Response.json({ error: "Expected { path: string, binding: boolean }, { path: string, category: \"material\" | \"exam\" | \"reference\" }, { path: string, materialKind: \"complete\" | \"overview\" } or { path: string, retry: true }" }, { status: 400 });
	}
	const material = record.courseMaterial;
	const target = material?.files.find((file) => file.path === body.path);
	if (!material || !target) return Response.json({ error: "Unknown course file" }, { status: 404 });
	if (hasRetry) {
		if (target.status !== "failed") return Response.json({ error: "Only a failed course file can be retried." }, { status: 409 });
		if (!target.binding) return Response.json({ error: "Tick the file to read it again." }, { status: 409 });
		const { error: _error, ...rest } = target;
		stores.chatStore.setCourseMaterial(id, {
			...clearFailedBookRoutes(material, target.path),
			files: material.files.map((file) => (file.path === target.path ? { ...rest, status: "pending" as const } : file)),
		});
		emit("course-material-changed", { chatId: id });
		if (target.update && !target.update.nodes) assignReplacedCourseFile(id, target.path);
		else assignAddedCourseFiles(id, [target.path]);
		syncBookRoutes(id);
		return Response.json({ ok: true });
	}
	if (hasMaterialKind) {
		const materialKind = body.materialKind as "complete" | "overview";
		if (fileCategory(target) !== "material") return Response.json({ error: "Only course material can be labelled Complete or Overview." }, { status: 400 });
		if (fileMaterialKind(target) === materialKind) return Response.json({ ok: true });
		stores.chatStore.setCourseMaterial(id, {
			...material,
			files: material.files.map((file) => (file.path === target.path ? { ...file, materialKind, materialKindBy: "learner" as const } : file)),
		});
		emit("course-material-changed", { chatId: id });
		syncBookRoutes(id);
		return Response.json({ ok: true });
	}
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
		const { error: _error, materialKind: _kind, materialKindBy: _kindBy, ...rest } = target;
		const { examPatterns, referenceIndex, referencePointers, bookRoutes, ...others } = material;
		stores.chatStore.setCourseMaterial(id, {
			...others,
			files: material.files.map((file) => (file.path === target.path ? { ...rest, category, categoryBy: "learner" as const, status: "pending" as const } : file)),
			methods: material.methods.filter((method) => method.path !== target.path),
			conflicts,
			...(examPatterns ? { examPatterns: examPatterns.filter((pattern) => pattern.path !== target.path) } : {}),
			...(referenceIndex ? { referenceIndex: referenceIndex.filter((entry) => entry.path !== target.path) } : {}),
			...(referencePointers ? { referencePointers: referencePointers.filter((pointer) => pointer.path !== target.path) } : {}),
			...(bookRoutes ? { bookRoutes: bookRoutes.filter((route) => route.path !== target.path) } : {}),
		});
		emit("course-material-changed", { chatId: id });
		assignAddedCourseFiles(id, [target.path]);
		syncBookRoutes(id);
		return Response.json({ ok: true });
	}
	const binding = body.binding as boolean;
	stores.chatStore.setCourseMaterial(id, {
		...material,
		files: material.files.map((file) => (file.path === target.path ? { ...file, binding } : file)),
	});
	emit("course-material-changed", { chatId: id });
	syncBookRoutes(id);
	return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
	if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.path !== "string") {
		return Response.json({ error: "Expected { path: string }" }, { status: 400 });
	}
	const path = body.path;
	const material = record.courseMaterial;
	if (!material?.files.some((file) => file.path === path)) return Response.json({ error: "Unknown course file" }, { status: 404 });
	stores.chatStore.setCourseMaterial(id, removeCourseFile(material, path));
	cancelCourseFile(id, path);
	emit("course-material-changed", { chatId: id });
	return Response.json({ ok: true });
}
