import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { emit } from "../../core/events.ts";
import type { ChatStore } from "../../core/ports.ts";

export interface CourseRouteToolContext {
	chatId: string;
	chatStore: ChatStore;
}

const courseRouteInput = Type.Object({
	nodeId: Type.String({ minLength: 1 }),
	path: Type.String({ minLength: 1 }),
});

function reply(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

export function courseRouteTool(ctx: CourseRouteToolContext): Record<string, AgentTool<any>> {
	return {
		course_route: {
			name: "course_route",
			label: "course_route",
			description:
				"Records which course file's route the learner's course uses for a node whose course files disagree. Call it only after the learner chose via ask_user_question. Later course-method notes show only that route.",
			parameters: courseRouteInput,
			execute: async (_toolCallId, params: { nodeId: string; path: string }) => {
				const { nodeId, path } = params;
				const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
				if (!tree?.nodes.some((n) => n.id === nodeId)) return reply(`Unknown node id: ${nodeId}`);
				const material = ctx.chatStore.getCourseMaterial(ctx.chatId);
				const conflict = material?.conflicts.find((c) => c.nodeId === nodeId);
				if (!material || !conflict) return reply(`Node ${nodeId} has no conflicting course methods.`);
				if (!conflict.paths.includes(path)) return reply(`Not one of this node's conflicting course files: ${path}`);
				ctx.chatStore.setCourseMaterial(ctx.chatId, {
					...material,
					conflicts: material.conflicts.map((c) => (c === conflict ? { ...c, chosen: path } : c)),
				});
				emit("course-material-changed", { chatId: ctx.chatId });
				return reply(`Recorded: node ${nodeId} follows ${path.split(/[\\/]/).pop() || path}.`);
			},
		},
	};
}
