import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	BOOK_ROUTE_INSTRUCTIONS,
	buildBookRoutePrompt,
	parseBookRoute,
	type BookRouteWorker,
} from "../../core/book-routes.ts";
import type { PiEngine } from "../models.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import { createWorkerRequestScope } from "../worker-request-admission.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";

/**
 * The book-route worker (plan 020 part 3): reads the pointed sections of ONE
 * reference file for ONE plan node and writes down the book's route. PDFs ride
 * the pdf-reader with the union of the sections' pages; text files get the
 * pointed line ranges in one no-tools call. The course-assign engine slot.
 */

export interface BookRouteWorkerOptions {
	/** Resolved fresh per job; undefined = no engine configured. */
	engineFor: () => PiEngine | undefined;
	runPdfReader?: typeof runPdfReaderAgent;
}

function jsonCandidate(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** Sort and merge overlapping or touching ranges. */
function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
	const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]).sort((x, y) => x[0] - y[0]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

async function streamNoTools(engine: PiEngine, system: string, content: string, signal: AbortSignal): Promise<string> {
	const requests = createWorkerRequestScope(engine.streamFn, signal);
	try {
		const reasoning = engine.level;
		const messages: Message[] = [{ role: "user", content, timestamp: Date.now() }];
		const stream = requests.streamFn(engine.model, normalizeContext({ systemPrompt: system, messages, tools: [] }), {
			sessionId: randomUUID(),
			reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
			signal,
		} as never);
		let reply: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") {
				reply = event.message;
				break;
			}
			if (event.type === "error") {
				if (event.reason === "aborted") {
					const err = new Error("aborted");
					err.name = "AbortError";
					throw err;
				}
				throw new Error(event.error.errorMessage ?? "the model call failed");
			}
		}
		if (!reply) throw new Error("the model stream ended without a result");
		return reply.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	} finally {
		requests.close();
	}
}

export function createBookRouteWorker(options: BookRouteWorkerOptions): BookRouteWorker {
	const runPdfReader = options.runPdfReader ?? runPdfReaderAgent;
	return async (input) => {
		const engine = options.engineFor();
		if (!engine) return { ok: false, error: "No model is configured for reading course files." };

		const wanted = new Set(input.sectionIds);
		const ranges = mergeRanges(input.sections.filter((s) => wanted.has(s.id)).map((s) => [s.startPage, s.endPage] as const));
		if (ranges.length === 0) return { ok: false, error: "The pointed sections are not in the reference index." };
		const isText = input.referenceFrom === "headings";
		const node = { id: input.nodeId, title: input.nodeTitle, ...(input.nodeSummary ? { summary: input.nodeSummary } : {}) };

		let pagesSpec: string | undefined;
		let sectionsText: string | undefined;
		if (isText) {
			const lines = (await readFile(resolveSourcePath(input.path), "utf8")).split("\n");
			sectionsText = ranges
				.map(([from, to]) => `Lines ${from}-${to}:\n${lines.slice(from - 1, to).join("\n")}`)
				.join("\n\n");
		} else {
			pagesSpec = ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(",");
		}
		const prompt = buildBookRoutePrompt({
			path: input.path,
			node,
			overviewMethods: input.overviewMethods,
			...(pagesSpec ? { pagesSpec } : {}),
			...(sectionsText ? { sectionsText } : {}),
		});

		let problems: string[] = [];
		let extra = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const task = extra ? `${prompt}\n\n${extra}` : prompt;
			let answer: string;
			if (isText) {
				answer = jsonCandidate(await streamNoTools(engine, BOOK_ROUTE_INSTRUCTIONS, task, input.abortSignal));
			} else {
				const result = await runPdfReader(
					{ path: input.path, question: task, ...(pagesSpec ? { pages: pagesSpec } : {}) },
					{ engine, abortSignal: input.abortSignal, chatId: input.chatId, instructionsSuffix: BOOK_ROUTE_INSTRUCTIONS },
				);
				if (/^PDF failed:/i.test(result.brief)) return { ok: false, error: result.brief.replace(/^PDF failed:\s*/i, "") };
				answer = jsonCandidate(result.brief);
			}
			const parsed = parseBookRoute(answer);
			if (parsed.ok) {
				return parsed.kind === "covered" ? { ok: true, pages: parsed.pages, method: parsed.method } : { ok: false, error: "not covered" };
			}
			problems = parsed.problems;
			extra = `Your previous answer had these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object.`;
		}
		return { ok: false, error: problems.join("; ") || "Reading the book sections failed." };
	};
}
