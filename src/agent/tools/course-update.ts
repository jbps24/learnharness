import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { courseUpdateOpenItems } from "../../core/course-notes.ts";
import { emit } from "../../core/events.ts";
import type { ChatStore } from "../../core/ports.ts";

export interface CourseUpdateToolContext {
	chatId: string;
	chatStore: ChatStore;
}

const courseUpdateInput = Type.Object({
	path: Type.String({ minLength: 1 }),
	item: Type.String({ minLength: 1 }),
});

function reply(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

export function courseUpdateTool(ctx: CourseUpdateToolContext): Record<string, AgentTool<any>> {
	return {
		course_update: {
			name: "course_update",
			label: "course_update",
			description:
				'Records that you handled one item of a [Course update] note: a changed route you pointed out (the node id) or the plan question you asked ("plan"). Handled items leave the note.',
			parameters: courseUpdateInput,
			execute: async (_toolCallId, params: { path: string; item: string }) => {
				const { path, item } = params;
				const material = ctx.chatStore.getCourseMaterial(ctx.chatId);
				const file = material?.files.find((f) => f.path === path);
				const update = file?.update;
				if (!material || !file || !update) return reply(`No course update for ${path}.`);
				const open = courseUpdateOpenItems(update, ctx.chatStore.getChat(ctx.chatId)?.messages ?? []);
				let next;
				if (item === "plan" && open.planOpen) next = { ...update, planAsked: true };
				else if (item !== "plan" && open.changed.includes(item)) next = { ...update, revisited: [...update.revisited, item] };
				else return reply(`Not an open item of this course update: ${item}`);
				ctx.chatStore.setCourseMaterial(ctx.chatId, {
					...material,
					files: material.files.map((f) => (f === file ? { ...f, update: next } : f)),
				});
				emit("course-material-changed", { chatId: ctx.chatId });
				return reply("Recorded.");
			},
		},
	};
}
