import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ReferenceSection } from "../../core/contracts/course.ts";
import { headingsToSections, outlineToSections, parseContentsToc, REFERENCE_TOC_TASK } from "../../core/reference-toc.ts";
import type { PiEngine } from "../models.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import type { HeadlessApi } from "./headless.ts";
import { pdfOutline } from "./pdf-ops.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";

export interface ReferenceTocInput {
	path: string;
	abortSignal?: AbortSignal;
	chatId?: string;
}

export interface ReferenceTocOptions {
	engine?: PiEngine;
	engineFor?: () => PiEngine | undefined;
	headless?: HeadlessApi;
}

export type ReferenceTocResult =
	| { ok: true; from: "outline" | "contents" | "headings"; sections: ReferenceSection[] }
	| { ok: false; error: string };

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".tex"];

/** Extract a Reference file's table of contents (outline, PDF contents fallback, or text headings). */
export async function extractReferenceToc(
	input: ReferenceTocInput,
	opts: ReferenceTocOptions = {},
): Promise<ReferenceTocResult> {
	const ext = path.extname(input.path).toLowerCase();
	try {
		if (TEXT_EXTENSIONS.includes(ext)) {
			const text = await readFile(resolveSourcePath(input.path), "utf8");
			const sections = headingsToSections(text, ext);
			if (sections.length === 0) return { ok: false, error: "No headings found in this file." };
			return { ok: true, from: "headings", sections };
		}
		if (ext !== ".pdf") return { ok: false, error: `Unsupported reference file type: ${ext || "(none)"}` };

		const outline = await pdfOutline(resolveSourcePath(input.path));
		const fromOutline = outlineToSections(outline.items, outline.pageCount, outline.pageLabels);
		if (fromOutline.length > 0) return { ok: true, from: "outline", sections: fromOutline };

		const engine = opts.engine ?? opts.engineFor?.();
		if (!engine) return { ok: false, error: "No model is configured for reading the table of contents." };
		const result = await runPdfReaderAgent(
			{ path: input.path, question: REFERENCE_TOC_TASK },
			{
				engine,
				...(opts.headless ? { headless: opts.headless } : {}),
				...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
				...(input.chatId ? { chatId: input.chatId } : {}),
			},
		);
		if (/^PDF failed:/i.test(result.brief)) return { ok: false, error: result.brief.replace(/^PDF failed:\s*/i, "") };
		const parsed = parseContentsToc(result.brief, outline.pageCount, outline.pageLabels);
		if (!parsed.ok) return { ok: false, error: parsed.problems.join("; ") };
		return { ok: true, from: "contents", sections: parsed.sections };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
