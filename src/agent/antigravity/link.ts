import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { AGY_WORKSPACES_DIR } from "../../../config.ts";

export interface AgyLink {
	conversationId: string;
	fingerprint: string;
	/** The model the conversation runs on, and how many chat messages (system left out) it was sent. */
	model?: string;
	messageCount?: number;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isSafeChatId(chatId: string): boolean {
	return SAFE_SEGMENT.test(chatId);
}

function safeId(chatId: string): string {
	if (!SAFE_SEGMENT.test(chatId)) throw new Error(`Unsafe chat id for an antigravity workspace: ${JSON.stringify(chatId)}`);
	return chatId;
}

function workspaceDir(chatId: string): string {
	return path.join(AGY_WORKSPACES_DIR, safeId(chatId));
}

function ensureWorkspaceDir(chatId: string): string {
	const dir = workspaceDir(chatId);
	fs.mkdirSync(AGY_WORKSPACES_DIR, { recursive: true, mode: 0o700 });
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	return dir;
}

/** The link file lives inside the chat's workspace folder (<DATA_ROOT>/agy/<chatId>/link.json). */
function linkFile(chatId: string): string {
	return path.join(workspaceDir(chatId), "link.json");
}

/** The chat's fixed workspace folder (0700), created with an empty MCP config. */
export function workspaceFor(chatId: string): string {
	const dir = ensureWorkspaceDir(chatId);
	const agents = path.join(dir, ".agents");
	fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
	const mcp = path.join(agents, "mcp_config.json");
	if (!fs.existsSync(mcp)) fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
	fs.chmodSync(mcp, 0o600);
	return dir;
}

export function readLink(chatId: string): AgyLink | null {
	const file = linkFile(chatId);
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		const { conversationId, fingerprint: fp } = parsed as Record<string, unknown>;
		if (typeof conversationId !== "string" || !conversationId) return null;
		if (typeof fp !== "string" || !fp) return null;
		const { model, messageCount } = parsed as Record<string, unknown>;
		return {
			conversationId,
			fingerprint: fp,
			...(typeof model === "string" && model ? { model } : {}),
			...(typeof messageCount === "number" && Number.isInteger(messageCount) && messageCount >= 0 ? { messageCount } : {}),
		};
	} catch {
		return null;
	}
}

export function writeLink(chatId: string, link: AgyLink): void {
	ensureWorkspaceDir(chatId);
	const file = linkFile(chatId);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ conversationId: link.conversationId, fingerprint: link.fingerprint, model: link.model, messageCount: link.messageCount }), { mode: 0o600 });
	fs.renameSync(tmp, file);
	fs.chmodSync(file, 0o600);
}

export function deleteLink(chatId: string): void {
	fs.rmSync(linkFile(chatId), { force: true });
}

/** Hash of what the agy conversation was built from: system prompt, tools and
 *  message content. Timestamps, usage and message ids are left out. */
export function fingerprint(systemPrompt: string, tools: readonly Tool[], messages: readonly Message[]): string {
	const canonical = {
		systemPrompt,
		tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		messages: messages.flatMap((message): unknown[] => {
			switch (message.role) {
				case "system":
					return [];
				case "user":
					return [{ role: "user", content: message.content }];
				case "assistant":
					return [{ role: "assistant", content: message.content }];
				case "toolResult":
					return [
						{
							role: "toolResult",
							toolCallId: message.toolCallId,
							toolName: message.toolName,
							content: message.content,
							isError: message.isError,
						},
					];
			}
		}),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Removes the chat's workspace folder, including its link. */
export function removeWorkspace(chatId: string): void {
	fs.rmSync(workspaceDir(chatId), { recursive: true, force: true });
}
