import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { extractReferenceToc } from "../src/agent/subagents/reference-toc.ts";
import { REFERENCE_SECTIONS_CAP } from "../src/core/contracts/course.ts";
import {
	headingsToSections,
	outlineToSections,
	parseContentsToc,
	REFERENCE_TOC_TASK,
	type OutlineInputItem,
} from "../src/core/reference-toc.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function pdfWithOutline(): Uint8Array<ArrayBuffer> {
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 1 >>] >> >>",
		"<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 2 >>",
		"<< /Title (Preface) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
		"<< /Title (Chapter 1) /Parent 6 0 R /Prev 7 0 R /Dest [4 0 R /Fit] >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
}

describe("REFERENCE_TOC_TASK", () => {
	// plan 012 part 2: confirmed contents task verbatim
	it("matches the owner-confirmed prompt verbatim", () => {
		assert.equal(
			REFERENCE_TOC_TASK,
			'Find this document\'s table of contents (usually within the first 30 pages). Return ONE JSON object: {"sections":[{"title":string,"level":1|2|3,"startPage":number}]}, with startPage as the PDF page index the pdf tools use — locate at least one section heading to find the offset between printed and PDF page numbers. Leave out front matter and the index.',
		);
	});
});

describe("outlineToSections", () => {
	// plan 012 part 2: walk getOutline(), drop entries without a page, endPage = next same-or-higher level - 1, last = page count, labels from getPageLabels()
	it("flattens nested items, drops entries without a page, computes endPage and attaches labels", () => {
		const items: OutlineInputItem[] = [
			{
				title: "Chapter 1",
				page: 1,
				items: [
					{ title: "Section 1.1", page: 2 },
					{ title: "Section 1.2", page: 5 },
				],
			},
			{ title: "Unlinked", page: null },
			{ title: "Out of range", page: 25 },
			{ title: "Chapter 2", page: 10 },
		];
		const labels = Array.from({ length: 20 }, (_, i) => (i === 0 ? "i" : String(i)));

		const sections = outlineToSections(items, 20, labels);
		assert.equal(sections.length, 4);
		assert.equal(new Set(sections.map((s) => s.id)).size, 4);
		assert.ok(sections.every((s) => s.id.length > 0));

		assert.deepEqual(
			sections.map(({ title, level, startPage, endPage, label }) => ({ title, level, startPage, endPage, label })),
			[
				{ title: "Chapter 1", level: 1, startPage: 1, endPage: 9, label: "i" },
				{ title: "Section 1.1", level: 2, startPage: 2, endPage: 4, label: "1" },
				{ title: "Section 1.2", level: 2, startPage: 5, endPage: 9, label: "4" },
				{ title: "Chapter 2", level: 1, startPage: 10, endPage: 20, label: "9" },
			],
		);
	});

	// plan 012 part 2: endPage when consecutive entries share a page
	it("clamps endPage to at least startPage when consecutive same-level entries share a page", () => {
		const sections = outlineToSections(
			[
				{ title: "Sec A", page: 5 },
				{ title: "Sec B", page: 5 },
			],
			10,
		);
		assert.equal(sections[0]!.startPage, 5);
		assert.equal(sections[0]!.endPage, 5);
		assert.equal(sections[1]!.endPage, 10);
	});

	// plan 012 part 2: empty outline and REFERENCE_SECTIONS_CAP (800) cap
	it("returns empty array for empty outline and caps at REFERENCE_SECTIONS_CAP (800)", () => {
		assert.equal(REFERENCE_SECTIONS_CAP, 800);
		assert.deepEqual(outlineToSections([], 10), []);

		const many: OutlineInputItem[] = Array.from({ length: 850 }, (_, i) => ({
			title: `Section ${i + 1}`,
			page: i + 1,
		}));
		const capped = outlineToSections(many, 900);
		assert.equal(capped.length, 800);
	});
});

describe("parseContentsToc", () => {
	// plan 012 part 2: contents JSON parsed and checked by reference-toc.ts
	it("parses valid JSON (and fenced JSON), computes endPage, and attaches labels", () => {
		const raw = JSON.stringify({
			sections: [
				{ title: "Chapter 1", level: 1, startPage: 3 },
				{ title: "Section 1.1", level: 2, startPage: 4 },
				{ title: "Chapter 2", level: 1, startPage: 8 },
			],
		});
		const labels = ["i", "ii", "1", "2", "3", "4", "5", "6", "7", "8"];

		const res = parseContentsToc(raw, 10, labels);
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.sections.length, 3);
		assert.equal(new Set(res.sections.map((s) => s.id)).size, 3);
		assert.deepEqual(
			res.sections.map(({ title, level, startPage, endPage, label }) => ({ title, level, startPage, endPage, label })),
			[
				{ title: "Chapter 1", level: 1, startPage: 3, endPage: 7, label: "1" },
				{ title: "Section 1.1", level: 2, startPage: 4, endPage: 7, label: "2" },
				{ title: "Chapter 2", level: 1, startPage: 8, endPage: 10, label: "6" },
			],
		);

		const fenced = `Here is the TOC:\n\`\`\`json\n${raw}\n\`\`\``;
		const fencedRes = parseContentsToc(fenced, 10, labels);
		assert.equal(fencedRes.ok, true);
	});

	// plan 012 part 2: pages increasing, within the document
	it("rejects decreasing pages, out-of-document pages, invalid JSON, and empty sections", () => {
		const decreasing = JSON.stringify({
			sections: [
				{ title: "Ch 1", level: 1, startPage: 8 },
				{ title: "Ch 2", level: 1, startPage: 5 },
			],
		});
		assert.equal(parseContentsToc(decreasing, 10).ok, false);

		const zeroPage = JSON.stringify({
			sections: [{ title: "Ch 1", level: 1, startPage: 0 }],
		});
		assert.equal(parseContentsToc(zeroPage, 10).ok, false);

		const pastEnd = JSON.stringify({
			sections: [{ title: "Ch 1", level: 1, startPage: 11 }],
		});
		assert.equal(parseContentsToc(pastEnd, 10).ok, false);

		assert.equal(parseContentsToc("not json", 10).ok, false);
		assert.equal(parseContentsToc(JSON.stringify({ sections: [] }), 10).ok, false);
	});

	// plan 012 part 2: REFERENCE_SECTIONS_CAP (800) cap on contents TOC
	it("caps parsed contents sections at REFERENCE_SECTIONS_CAP (800)", () => {
		const raw = JSON.stringify({
			sections: Array.from({ length: 850 }, (_, i) => ({
				title: `Sec ${i + 1}`,
				level: 1,
				startPage: i + 1,
			})),
		});
		const res = parseContentsToc(raw, 900);
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.sections.length, 800);
	});
});

describe("headingsToSections", () => {
	// plan 012 part 2: .md .markdown .txt # headings with line numbers as pages
	it("extracts # headings from markdown/txt with 1-based line numbers as startPage and endPage", () => {
		const md = [
			"# Intro",
			"Some text.",
			"## Motivation",
			"More text.",
			"### Details",
			"Detail text.",
			"# Main",
			"Final text.",
		].join("\n");

		for (const ext of [".md", ".markdown", ".txt"]) {
			const sections = headingsToSections(md, ext);
			assert.equal(sections.length, 4, ext);
			assert.equal(new Set(sections.map((s) => s.id)).size, 4, ext);
			assert.deepEqual(
				sections.map(({ title, level, startPage, endPage }) => ({ title, level, startPage, endPage })),
				[
					{ title: "Intro", level: 1, startPage: 1, endPage: 6 },
					{ title: "Motivation", level: 2, startPage: 3, endPage: 6 },
					{ title: "Details", level: 3, startPage: 5, endPage: 6 },
					{ title: "Main", level: 1, startPage: 7, endPage: 8 },
				],
			);
		}
	});

	// plan 012 part 2: .tex \chapter \section \subsection with line numbers as pages
	it("extracts \\chapter, \\section, \\subsection from .tex with line numbers as pages", () => {
		const tex = [
			"\\documentclass{book}",
			"\\begin{document}",
			"\\chapter{Linear Algebra}",
			"Intro.",
			"\\section{Vector Spaces}",
			"Defs.",
			"\\subsection{Bases}",
			"Proof.",
			"\\chapter{Eigenvalues}",
			"End.",
		].join("\n");

		const sections = headingsToSections(tex, ".tex");
		assert.equal(sections.length, 4);
		assert.equal(new Set(sections.map((s) => s.id)).size, 4);
		assert.deepEqual(
			sections.map(({ title, level, startPage, endPage }) => ({ title, level, startPage, endPage })),
			[
				{ title: "Linear Algebra", level: 1, startPage: 3, endPage: 8 },
				{ title: "Vector Spaces", level: 2, startPage: 5, endPage: 8 },
				{ title: "Bases", level: 3, startPage: 7, endPage: 8 },
				{ title: "Eigenvalues", level: 1, startPage: 9, endPage: 10 },
			],
		);
	});

	// plan 012 part 2: empty text and REFERENCE_SECTIONS_CAP (800) cap on headings
	it("returns empty array for empty or headingless text and caps at REFERENCE_SECTIONS_CAP (800)", () => {
		assert.deepEqual(headingsToSections("", ".md"), []);
		assert.deepEqual(headingsToSections("Just plain prose.\nNo headings.", ".txt"), []);

		const many = Array.from({ length: 850 }, (_, i) => `# Heading ${i + 1}`).join("\n");
		assert.equal(headingsToSections(many, ".md").length, 800);
	});
});

describe("extractReferenceToc", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ref-toc-"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// plan 012 part 2: Outline (from: "outline") without model fallback
	it("uses PDF outline without calling the model when the PDF has an outline", async () => {
		const file = path.join(tmpDir, "outlined.pdf");
		fs.writeFileSync(file, pdfWithOutline());

		const engine = fauxEngine([]);
		engine.streamFn = () => {
			throw new Error("model must not be called when PDF has an outline");
		};

		const res = await extractReferenceToc({ path: file }, { engine });
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.from, "outline");
		assert.deepEqual(
			res.sections.map(({ title, level, startPage, endPage, label }) => ({ title, level, startPage, endPage, label })),
			[
				{ title: "Preface", level: 1, startPage: 1, endPage: 1, label: "i" },
				{ title: "Chapter 1", level: 1, startPage: 2, endPage: 3, label: "1" },
			],
		);
	});

	// plan 012 part 2: No outline, PDF (from: "contents") via pdf-reader loop with confirmed task
	it("falls back to pdf-reader with REFERENCE_TOC_TASK when PDF has no outline", async () => {
		const file = path.join(tmpDir, "no-outline.pdf");
		fs.writeFileSync(
			file,
			tinyPdf([
				{ runs: [{ text: "Contents: Ch 1 p.1, Ch 2 p.2", x: 72, y: 700 }] },
				{ runs: [{ text: "Chapter 2 body", x: 72, y: 700 }] },
			]),
		);

		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(
					JSON.stringify({
						sections: [
							{ title: "Chapter 1", level: 1, startPage: 1 },
							{ title: "Chapter 2", level: 1, startPage: 2 },
						],
					}),
				),
			]),
		]);
		let firstContext = "";
		const origStream = engine.streamFn;
		engine.streamFn = (...args) => {
			if (!firstContext) firstContext = JSON.stringify(args[1]);
			return origStream(...args);
		};

		const res = await extractReferenceToc({ path: file }, { engine });
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.from, "contents");
		assert.ok(firstContext.includes("Find this document's table of contents"));
		assert.deepEqual(
			res.sections.map(({ title, level, startPage, endPage }) => ({ title, level, startPage, endPage })),
			[
				{ title: "Chapter 1", level: 1, startPage: 1, endPage: 1 },
				{ title: "Chapter 2", level: 1, startPage: 2, endPage: 2 },
			],
		);
	});

	// plan 012 part 2: contents TOC validation failure returns error
	it("returns ok: false when fallback reader returns out-of-range or decreasing pages", async () => {
		const file = path.join(tmpDir, "bad-contents.pdf");
		fs.writeFileSync(file, tinyPdf([{ runs: [{ text: "Page 1", x: 72, y: 700 }] }]));

		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(JSON.stringify({ sections: [{ title: "Ch 1", level: 1, startPage: 99 }] })),
			]),
		]);

		const res = await extractReferenceToc({ path: file }, { engine });
		assert.equal(res.ok, false);
	});

	// plan 012 part 2: Text files (from: "headings") without model call
	it("extracts headings from .md and .tex without calling the model", async () => {
		const mdFile = path.join(tmpDir, "book.md");
		fs.writeFileSync(mdFile, "# Chapter 1\nText\n## Section 1.1\nMore");

		const texFile = path.join(tmpDir, "book.tex");
		fs.writeFileSync(texFile, "\\chapter{One}\nText\n\\section{Sub}\nMore");

		const engine = fauxEngine([]);
		engine.streamFn = () => {
			throw new Error("model must not be called for text files");
		};

		const mdRes = await extractReferenceToc({ path: mdFile }, { engine });
		assert.equal(mdRes.ok, true);
		if (mdRes.ok) {
			assert.equal(mdRes.from, "headings");
			assert.equal(mdRes.sections.length, 2);
		}

		const texRes = await extractReferenceToc({ path: texFile }, { engine });
		assert.equal(texRes.ok, true);
		if (texRes.ok) {
			assert.equal(texRes.from, "headings");
			assert.equal(texRes.sections.length, 2);
		}

		for (const name of ["book.markdown", "book.txt"]) {
			const f = path.join(tmpDir, name);
			fs.writeFileSync(f, "# Chapter 1\nText\n## Section 1.1\nMore");
			const r = await extractReferenceToc({ path: f }, { engine });
			assert.equal(r.ok, true, name);
			if (r.ok) {
				assert.equal(r.from, "headings", name);
				assert.equal(r.sections.length, 2, name);
			}
		}
	});
});

describe("reference TOC edge cases", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ref-toc-edge-"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeEngine(steps: FauxResponseStep[]): PiEngine {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}

	function serializePdf(objects: string[]): Uint8Array<ArrayBuffer> {
		let pdf = "%PDF-1.4\n";
		const offsets: number[] = [];
		for (const [i, body] of objects.entries()) {
			offsets.push(pdf.length);
			pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
		}
		const xref = pdf.length;
		pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
		pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
	}

	function buildSingleOutlinePdf(): Uint8Array<ArrayBuffer> {
		return serializePdf([
			"<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
			"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
			"<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >>",
			"<< /Title (Only Chapter) /Parent 5 0 R /Dest [3 0 R /Fit] >>",
		]);
	}

	function buildPlainPdf(): Uint8Array<ArrayBuffer> {
		return serializePdf([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		]);
	}

	it("keeps an outline entry on the final page of the document", () => {
		const sections = outlineToSections([{ title: "Appendix", page: 5 }], 5);
		assert.equal(sections.length, 1);
		assert.equal(sections[0]!.startPage, 5);
		assert.equal(sections[0]!.endPage, 5);
	});

	it("allows consecutive contents sections starting on the same page", () => {
		const raw = JSON.stringify({
			sections: [
				{ title: "Sec A", level: 1, startPage: 5 },
				{ title: "Sec B", level: 1, startPage: 5 },
			],
		});
		const res = parseContentsToc(raw, 10);
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.sections.length, 2);
		assert.equal(res.sections[0]!.endPage, 5);
		assert.equal(res.sections[1]!.endPage, 10);
	});

	it("strips a trailing empty line so endPage matches the last content line", () => {
		const sections = headingsToSections("# Intro\nBody line\n", ".md");
		assert.equal(sections.length, 1);
		assert.equal(sections[0]!.startPage, 1);
		assert.equal(sections[0]!.endPage, 2);
	});

	it("uses the outline without calling the model when the PDF has a single outline entry", async () => {
		const file = path.join(tmpDir, "single-outline.pdf");
		fs.writeFileSync(file, buildSingleOutlinePdf());

		const engine = makeEngine([]);
		engine.streamFn = () => {
			throw new Error("model must not be called for single-entry outline");
		};

		const res = await extractReferenceToc({ path: file }, { engine });
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.from, "outline");
		assert.deepEqual(
			res.sections.map(({ title, level, startPage, endPage }) => ({ title, level, startPage, endPage })),
			[{ title: "Only Chapter", level: 1, startPage: 1, endPage: 2 }],
		);
	});

	it("recognizes uppercase file extensions such as .MD and .PDF", async () => {
		const mdFile = path.join(tmpDir, "BOOK.MD");
		fs.writeFileSync(mdFile, "# Chapter 1\nBody");
		const mdRes = await extractReferenceToc({ path: mdFile });
		assert.equal(mdRes.ok, true);
		if (mdRes.ok) {
			assert.equal(mdRes.from, "headings");
			assert.equal(mdRes.sections.length, 1);
		}

		const pdfFile = path.join(tmpDir, "BOOK.PDF");
		fs.writeFileSync(pdfFile, buildSingleOutlinePdf());
		const pdfRes = await extractReferenceToc({ path: pdfFile });
		assert.equal(pdfRes.ok, true);
		if (pdfRes.ok) {
			assert.equal(pdfRes.from, "outline");
			assert.equal(pdfRes.sections.length, 1);
		}
	});

	it("prefers explicit opts.engine over opts.engineFor when both are supplied", async () => {
		const file = path.join(tmpDir, "plain-prefer-engine.pdf");
		fs.writeFileSync(file, buildPlainPdf());

		const explicitEngine = makeEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(JSON.stringify({ sections: [{ title: "Explicit", level: 1, startPage: 1 }] })),
			]),
		]);
		const lazyEngine = makeEngine([]);
		lazyEngine.streamFn = () => {
			throw new Error("engineFor must not override explicit engine");
		};

		const res = await extractReferenceToc(
			{ path: file },
			{ engine: explicitEngine, engineFor: () => lazyEngine },
		);
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.from, "contents");
		assert.equal(res.sections[0]!.title, "Explicit");
	});

	it("forwards input.chatId to the PDF reader agent", async () => {
		const file = path.join(tmpDir, "plain-chat-id.pdf");
		fs.writeFileSync(file, buildPlainPdf());

		const engine = makeEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText(JSON.stringify({ sections: [{ title: "Chapter 1", level: 1, startPage: 1 }] })),
			]),
		]);
		let sawObserver = false;
		const origStream = engine.streamFn;
		engine.streamFn = (...args) => {
			const streamOpts = args[2] as { onProviderStreamEvent?: unknown } | undefined;
			if (typeof streamOpts?.onProviderStreamEvent === "function") sawObserver = true;
			return origStream(...args);
		};

		const prev = process.env.LH_PROVIDER_EVENTS;
		process.env.LH_PROVIDER_EVENTS = "1";
		try {
			const res = await extractReferenceToc({ path: file, chatId: "chat_ref_toc_1" }, { engine });
			assert.equal(res.ok, true);
			assert.equal(sawObserver, true);
		} finally {
			if (prev === undefined) delete process.env.LH_PROVIDER_EVENTS;
			else process.env.LH_PROVIDER_EVENTS = prev;
		}
	});
});
