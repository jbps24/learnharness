import { fileCategory, nodeAtMessage } from "@/src/core";
import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/practice/exam-coverage — per proposition, the number of distinct
 *  binding exam files with a pattern at the lesson node of its provenance
 *  (plan 010 part 4). Teaching lessons only; propositions with 0 are left out. */
export async function GET(): Promise<Response> {
	const { chatStore, graphStore } = stores;
	const lessons = new Map<string, ReturnType<typeof chatStore.getChat>>();
	const files = new Map<string, Set<string>>();
	for (const node of graphStore.readNodes()) {
		const paths = files.get(node.id) ?? new Set<string>();
		files.set(node.id, paths);
		for (const point of node.provenance) {
			if (!lessons.has(point.chatId)) lessons.set(point.chatId, chatStore.getChat(point.chatId));
			const lesson = lessons.get(point.chatId);
			const material = lesson?.courseMaterial;
			if (!lesson || !material || lesson.kind === "practice" || !lesson.tree) continue;
			const nodeId = nodeAtMessage(lesson.messages, lesson.tree, point.messageId);
			if (nodeId === null) continue;
			const exams = new Set(material.files.filter((f) => f.binding && fileCategory(f) === "exam").map((f) => f.path));
			for (const p of material.examPatterns ?? []) {
				if (p.nodeId === nodeId && exams.has(p.path)) paths.add(p.path);
			}
		}
	}
	const counts: Record<string, number> = {};
	for (const [id, paths] of files) if (paths.size > 0) counts[id] = paths.size;
	return Response.json({ counts });
}
