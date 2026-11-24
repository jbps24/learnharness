import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { pdfOutline } from "../src/agent/subagents/pdf-ops.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

/** Build a 5-page PDF with a nested outline, an unlinked entry, and /PageLabels (i, ii, 1, 2, 3). */
function pdfWithOutlineAndLabels(): Uint8Array<ArrayBuffer> {
	const objects: string[] = [
		// 1: Catalog with Outlines and PageLabels
		"<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageLabels << /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >> >>",
		// 2: Pages (pages are 3..7)
		"<< /Type /Pages /Count 5 /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
		// 8: Outlines root
		"<< /Type /Outlines /First 9 0 R /Last 11 0 R /Count 5 >>",
		// 9: Chapter 1 -> page 1 (obj 3), children 12..13
		"<< /Title (Chapter 1) /Parent 8 0 R /Next 10 0 R /First 12 0 R /Last 13 0 R /Count 2 /Dest [3 0 R /Fit] >>",
		// 10: Unlinked Part -> no /Dest
		"<< /Title (Unlinked Part) /Parent 8 0 R /Prev 9 0 R /Next 11 0 R >>",
		// 11: Chapter 2 -> page 4 (obj 6)
		"<< /Title (Chapter 2) /Parent 8 0 R /Prev 10 0 R /Dest [6 0 R /Fit] >>",
		// 12: Section 1.1 -> page 2 (obj 4)
		"<< /Title (Section 1.1) /Parent 9 0 R /Next 13 0 R /Dest [4 0 R /Fit] >>",
		// 13: Section 1.2 -> page 3 (obj 5)
		"<< /Title (Section 1.2) /Parent 9 0 R /Prev 12 0 R /Dest [5 0 R /Fit] >>",
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

describe("pdfOutline", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-outline-"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// plan 012 part 2: walk getOutline(), resolve each dest to a page index, labels from getPageLabels()
	it("extracts nested outline items with 1-based page indices, null for missing dest, and pageLabels", async () => {
		const file = path.join(tmpDir, "with-outline.pdf");
		fs.writeFileSync(file, pdfWithOutlineAndLabels());

		const outline = await pdfOutline(file);
		assert.equal(outline.pageCount, 5);
		assert.deepEqual(outline.pageLabels, ["i", "ii", "1", "2", "3"]);
		assert.deepEqual(outline.items, [
			{
				title: "Chapter 1",
				page: 1,
				items: [
					{ title: "Section 1.1", page: 2, items: [] },
					{ title: "Section 1.2", page: 3, items: [] },
				],
			},
			{ title: "Unlinked Part", page: null, items: [] },
			{ title: "Chapter 2", page: 4, items: [] },
		]);
	});

	// plan 012 part 2: PDF without an outline yields empty outline and pageCount
	it("returns empty items and null pageLabels for a PDF without an outline", async () => {
		const file = path.join(tmpDir, "no-outline.pdf");
		fs.writeFileSync(
			file,
			tinyPdf([
				{ runs: [{ text: "Page one", x: 72, y: 700 }] },
				{ runs: [{ text: "Page two", x: 72, y: 700 }] },
			]),
		);

		const outline = await pdfOutline(file);
		assert.equal(outline.pageCount, 2);
		assert.equal(outline.pageLabels, null);
		assert.deepEqual(outline.items, []);
	});
});

describe("pdfOutline numeric destinations", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-outline-num-"));
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function buildPdfWithNumericDest(): Uint8Array<ArrayBuffer> {
		const objects: string[] = [
			"<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
			"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
			"<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >>",
			"<< /Title (Second Page) /Parent 5 0 R /Dest [1 /Fit] >>",
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

	it("resolves numeric destinations as 1-based page numbers", async () => {
		const file = path.join(tmpDir, "numeric-dest.pdf");
		fs.writeFileSync(file, buildPdfWithNumericDest());

		const outline = await pdfOutline(file);
		assert.equal(outline.pageCount, 2);
		assert.deepEqual(outline.items, [{ title: "Second Page", page: 2, items: [] }]);
	});
});
