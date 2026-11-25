import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { stripReplayLines } from "./text-tool-calls.ts";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

type ReplayPart = string | ImageContent;

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message, stripAssistantText = false): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") {
					// Old turns may hold replay-format lines the model wrote as text; replaying them
					// would teach it the format again. The stored chat is left as it is.
					const text = stripAssistantText ? stripReplayLines(block.text).kept : block.text;
					return stripAssistantText && !text ? [] : [`[assistant]\n${text}`];
				}
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toContentBlocks(parts: ReplayPart[]): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toUserContent(conversation: Message[], stripAssistantText = false): ClaudeContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);

	return toContentBlocks(conversation.flatMap((message) => getReplayParts(message, stripAssistantText)));
}

/** Closes a replayed transcript so the model answers it instead of continuing it in the replay format. */
export const CLAUDE_TRANSCRIPT_END =
	"[end of transcript]\n" +
	"Everything above is the earlier conversation, replayed as labelled lines. Reply to the last message as the assistant. " +
	"Do not write lines that start with [assistant], [user], [tool call …] or [tool result …]. " +
	"To use a tool, make a real tool call; a tool call written as text does nothing.";

export function toClaudeInput(messages: Message[]): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		userContent: toUserContent(conversation),
	};
}

/** The claude-code replay: past assistant text loses replay-format lines, a replayed conversation gets a closing block. */
export function toClaudeCliInput(messages: Message[]): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const [first] = conversation;
	const single = conversation.length === 1 && first?.role === "user";
	const userContent = toUserContent(conversation, true);

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		userContent: single ? userContent : [...userContent, { type: "text", text: CLAUDE_TRANSCRIPT_END }],
	};
}

export function toStreamJsonLine(content: ClaudeContentBlock[]): string {
	return JSON.stringify({ type: "user", message: { role: "user", content } });
}
