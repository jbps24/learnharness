import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AssistantMessage, Message, ToolResultMessage, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	buildAssignmentPrompt,
	COURSE_ASSIGN_INSTRUCTIONS,
	COURSE_ASSIGN_REPLACE_INSTRUCTIONS,
	parseAssignment,
	type AssignmentResult,
	type CourseAssignWorker,
	type CourseAssignWorkerInput,
	type CourseAssignWorkerResult,
} from "../../core/course-assign.ts";
import { buildReferenceMapperPrompt, parseReferencePointers, REFERENCE_MAPPER_INSTRUCTIONS } from "../../core/reference-pointers.ts";
import type { PiEngine } from "../models.ts";
import { extractReferenceToc } from "./reference-toc.ts";
import { createWorkerRequestScope } from "../worker-request-admission.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";

/**
 * The course-assignment worker (plan 007 part 3): reads ONE course file
 * against the plan's nodes and returns the course's route per node. PDFs ride
 * the pdf-reader's loop and tools (its reading doctrine verbatim, the
 * assignment instructions appended); text files are read whole, paged like
 * `read` (2000 lines / 50 KB per chunk), by a small loop of its own.
 */

const CHUNK_LINES = 2000;
const CHUNK_BYTES = 50 * 1024;

export interface CourseAssignWorkerOptions {
	/** Resolved fresh per job; undefined = no engine configured. */
	engineFor: () => PiEngine | undefined;
}

/** Split text into chunks of at most 2000 lines / 50 KB, cut at line ends. */
export function chunkText(text: string): string[] {
	const chunks: string[] = [];
	let lines: string[] = [];
	let bytes = 0;
	for (const line of text.split("\n")) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (lines.length > 0 && (lines.length >= CHUNK_LINES || bytes + size > CHUNK_BYTES)) {
			chunks.push(lines.join("\n"));
			lines = [];
			bytes = 0;
		}
		lines.push(line);
		bytes += size;
	}
	chunks.push(lines.join("\n"));
	return chunks;
}

function jsonCandidate(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

const readChunkTool: Tool = {
	name: "read_chunk",
	description: "Read one numbered chunk of the course file (chunks are at most 2000 lines / 50 KB). Page through all chunks before answering.",
	parameters: Type.Object({ chunk: Type.Integer({ minimum: 1, description: "Chunk number, starting at 1" }) }),
};

function toolText(toolCallId: string, value: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: readChunkTool.name,
		content: [{ type: "text", text: value }],
		isError: value.startsWith("ERROR:"),
		timestamp: Date.now(),
	};
}

async function streamOnce(engine: PiEngine, systemPrompt: string, messages: Message[], sessionId: string, signal: AbortSignal, streamFn: PiEngine["streamFn"], tools: Tool[] = [readChunkTool]): Promise<AssistantMessage> {
	const reasoning = engine.level;
	const stream = streamFn(engine.model, normalizeContext({ systemPrompt, messages, tools }), {
		sessionId,
		reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
		signal,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}

/** Read a text file by paging; the final assistant text is the raw answer. */
async function runTextAssignment(engine: PiEngine, path: string, prompt: string, signal: AbortSignal, system: string): Promise<string> {
	const chunks = chunkText(await readFile(resolveSourcePath(path), "utf8"));
	const requests = createWorkerRequestScope(engine.streamFn, signal);
	const sessionId = randomUUID();
	let messages: Message[] = [
		{
			role: "user",
			content: `${prompt}\n\nThe file has ${chunks.length} chunk(s); read them with read_chunk.`,
			timestamp: Date.now(),
		},
	];
	try {
		for (;;) {
			const reply = await streamOnce(engine, system, messages, sessionId, signal, requests.streamFn);
			messages = [...messages, reply];
			const calls = reply.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
			if (calls.length === 0) {
				return reply.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
			}
			const results = calls.map((call) => {
				const n = Number((call.arguments as { chunk?: unknown } | undefined)?.chunk);
				const body = chunks[n - 1];
				return toolText(
					call.id,
					body === undefined ? `ERROR: chunk ${String(n)} does not exist (1–${chunks.length})` : `Chunk ${n} of ${chunks.length}:\n${body}`,
				);
			});
			messages = [...messages, ...results];
		}
	} finally {
		requests.close();
	}
}

type ReferenceIndex = NonNullable<CourseAssignWorkerInput["referenceIndex"]>;

/** The pointer mapper (plan 012 part 3): one no-tools call over the TOC lines, one repair attempt. */
async function runPointerMapper(
	engine: PiEngine,
	input: CourseAssignWorkerInput,
	index: ReferenceIndex,
): Promise<CourseAssignWorkerResult> {
	const prompt = buildReferenceMapperPrompt({ path: input.path, sections: index.sections, targets: input.targets });
	const targetIds = input.targets.map((t) => t.id);
	const sectionIds = index.sections.map((s) => s.id);
	const requests = createWorkerRequestScope(engine.streamFn, input.abortSignal);
	const sessionId = randomUUID();
	try {
		let extra = "";
		let problems: string[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			const reply = await streamOnce(
				engine,
				REFERENCE_MAPPER_INSTRUCTIONS,
				[{ role: "user", content: extra ? `${prompt}\n\n${extra}` : prompt, timestamp: Date.now() }],
				sessionId,
				input.abortSignal,
				requests.streamFn,
				[],
			);
			const text = reply.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			const parsed = parseReferencePointers(jsonCandidate(text), targetIds, sectionIds);
			if (parsed.ok) {
				return {
					ok: true,
					result: {
						category: "reference",
						nodes: parsed.nodes,
						...(input.referenceIndex ? {} : { index }),
					},
				};
			}
			problems = parsed.problems;
			extra = `Your previous answer had these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object.`;
		}
		return { ok: false, error: problems.join("; ") || "Mapping the reference failed." };
	} finally {
		requests.close();
	}
}

export function createCourseAssignWorker(options: CourseAssignWorkerOptions): CourseAssignWorker {
	return async (input: CourseAssignWorkerInput) => {
		const engine = options.engineFor();
		if (!engine) return { ok: false, error: "No model is configured for reading course files." };
		if (input.category === "reference" && input.referenceIndex) {
			return runPointerMapper(engine, input, input.referenceIndex);
		}
		const targetIds = input.targets.map((t) => t.id);
		const replace = input.previousMethods !== undefined;
		const instructions = replace ? `${COURSE_ASSIGN_INSTRUCTIONS}\n\n${COURSE_ASSIGN_REPLACE_INSTRUCTIONS}` : COURSE_ASSIGN_INSTRUCTIONS;
		const prompt = buildAssignmentPrompt({
			path: input.path,
			targets: input.targets,
			existingMethods: input.existingMethods,
			...(input.category ? { category: input.category } : {}),
			...(input.previousMethods ? { previousMethods: input.previousMethods } : {}),
		});
		const isPdf = input.path.toLowerCase().endsWith(".pdf");

		const run = async (extra: string): Promise<string | { failure: string }> => {
			const task = extra ? `${prompt}\n\n${extra}` : prompt;
			if (isPdf) {
				const result = await runPdfReaderAgent(
					{ path: input.path, question: task },
					{ engine, abortSignal: input.abortSignal, chatId: input.chatId, instructionsSuffix: instructions },
				);
				if (/^PDF failed:/i.test(result.brief)) return { failure: result.brief.replace(/^PDF failed:\s*/i, "") };
				return jsonCandidate(result.brief);
			}
			return jsonCandidate(await runTextAssignment(engine, input.path, task, input.abortSignal, instructions));
		};

		let parsed: ReturnType<typeof parseAssignment> | undefined;
		let extra = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const answer = await run(extra);
			if (typeof answer !== "string") return { ok: false, error: answer.failure };
			parsed = parseAssignment(answer, targetIds, { replace });
			if (parsed.ok && parsed.value.category === "reference") {
				let index = input.referenceIndex;
				if (!index) {
					const toc = await extractReferenceToc({ path: input.path, abortSignal: input.abortSignal, chatId: input.chatId }, { engine });
					if (!toc.ok) return { ok: false, error: toc.error };
					index = { from: toc.from, sections: toc.sections };
				}
				return runPointerMapper(engine, input, index);
			}
			if (parsed.ok) return { ok: true, result: parsed.value satisfies AssignmentResult };
			extra = `Your previous answer had these problems:\n${parsed.problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object.`;
		}
		return { ok: false, error: parsed && !parsed.ok ? parsed.problems.join("; ") : "Assignment failed." };
	};
}
