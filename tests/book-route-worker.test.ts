import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createBookRouteWorker } from "../src/agent/subagents/book-route.ts";
import { BOOK_ROUTE_INSTRUCTIONS, type BookRouteWorkerInput } from "../src/core/book-routes.ts";
import { parsePageSpec } from "../src/agent/subagents/pdf-ops.ts";
import { BOOK_ROUTE_CAP } from "../src/core/contracts/course.ts";

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function makeInput(overrides: Partial<BookRouteWorkerInput> = {}): BookRouteWorkerInput {
	return {
		chatId: "chat_1",
		nodeId: "n1",
		nodeTitle: "Laplace Transform",
		nodeSummary: "Definition and region of convergence",
		path: "/course/oppenheim.pdf",
		sectionIds: ["s1", "s2"],
		sections: [
			{ id: "s1", title: "9.1 The Laplace Transform", level: 2, startPage: 10, endPage: 15 },
			{ id: "s2", title: "9.2 Region of Convergence", level: 2, startPage: 15, endPage: 20 },
			{ id: "s3", title: "9.3 Unrelated", level: 2, startPage: 30, endPage: 40 },
		],
		referenceFrom: "outline",
		overviewMethods: [
			{ path: "/course/slides.pdf", pages: "slide 4", method: "Defines X(s) = integral x(t)e^{-st} dt." },
		],
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

describe("createBookRouteWorker", () => {
	// plan 020 part 3: uses the course-assign engine slot; fails when unconfigured
	it("returns an error when no engine is configured", async () => {
		const worker = createBookRouteWorker({ engineFor: () => undefined });
		const outcome = await worker(makeInput());
		assert.equal(outcome.ok, false);
		assert.ok(outcome.error.length > 0);
	});

	// plan 020 part 3: PDF worker calls runPdfReaderAgent with union page spec, node details, overview routes, and confirmed instructions
	it("reads PDF sections via runPdfReaderAgent with union page spec, node context, overview routes, and instructions", async () => {
		const calls: Array<{ path: string; question: string; pages?: string; instructionsSuffix?: string }> = [];
		const worker = createBookRouteWorker({
			engineFor: () => fauxEngine([]),
			runPdfReader: async (input, opts) => {
				calls.push({
					path: input.path,
					question: input.question,
					pages: input.pages,
					instructionsSuffix: opts?.instructionsSuffix,
				});
				return {
					path: input.path,
					question: input.question,
					brief: JSON.stringify({ pages: "pp. 10-20", method: "Step-by-step derivation (p. 10)." }),
					pagesRead: [10],
					pagesConsulted: [10],
				};
			},
		});

		const outcome = await worker(makeInput());
		assert.deepEqual(outcome, { ok: true, pages: "pp. 10-20", method: "Step-by-step derivation (p. 10)." });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.path, "/course/oppenheim.pdf");
		assert.equal(calls[0]!.pages, "10-20");
		assert.equal(calls[0]!.instructionsSuffix, BOOK_ROUTE_INSTRUCTIONS);
		assert.ok(calls[0]!.question.includes("n1"));
		assert.ok(calls[0]!.question.includes("Laplace Transform"));
		assert.ok(calls[0]!.question.includes("Definition and region of convergence"));
		assert.ok(calls[0]!.question.includes("Defines X(s) = integral x(t)e^{-st} dt."));
	});

	// plan 020 part 3: text reference files (from: "headings") slice pointed 1-based line ranges through the no-tools text path
	it("reads text reference files by slicing pointed line ranges through the no-tools text path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-route-"));
		const prevHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const filePath = path.join(dir, "book.md");
			fs.writeFileSync(
				filePath,
				[
					"# Chapter 1",
					"Line 2 unrelated",
					"## Section 1.1",
					"Derivation line 4",
					"Derivation line 5",
					"## Section 1.2",
					"Line 7 unrelated",
				].join("\n"),
				"utf8",
			);

			const engine = fauxEngine([
				fauxAssistantMessage([fauxText(JSON.stringify({ pages: "lines 3-5", method: "From lines 4 and 5." }))]),
			]);
			const seenContexts: Array<{ systemPrompt?: string; userContent: string; toolCount: number }> = [];
			const origStream = engine.streamFn;
			engine.streamFn = (model, context, options) => {
				const last = context.messages[context.messages.length - 1];
				const lead = context.messages[0];
				seenContexts.push({
					systemPrompt: lead?.role === "system" && typeof lead.content === "string" ? lead.content : undefined,
					userContent: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content),
					toolCount: lead?.role === "system" ? (lead.toolsAdded?.length ?? 0) : 0,
				});
				return origStream(model, context, options);
			};

			const worker = createBookRouteWorker({ engineFor: () => engine });
			const outcome = await worker(
				makeInput({
					path: filePath,
					sectionIds: ["s2"],
					sections: [
						{ id: "s1", title: "Chapter 1", level: 1, startPage: 1, endPage: 2 },
						{ id: "s2", title: "Section 1.1", level: 2, startPage: 3, endPage: 5 },
						{ id: "s3", title: "Section 1.2", level: 2, startPage: 6, endPage: 7 },
					],
					referenceFrom: "headings",
				}),
			);

			assert.deepEqual(outcome, { ok: true, pages: "lines 3-5", method: "From lines 4 and 5." });
			assert.equal(seenContexts.length, 1);
			assert.equal(seenContexts[0]!.toolCount, 0);
			assert.equal(seenContexts[0]!.systemPrompt, BOOK_ROUTE_INSTRUCTIONS);
			assert.ok(seenContexts[0]!.userContent.includes("Derivation line 4"));
			assert.ok(!seenContexts[0]!.userContent.includes("Line 2 unrelated"));
			assert.ok(!seenContexts[0]!.userContent.includes("Line 7 unrelated"));
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// plan 020 part 3: the pages are the union of the pointed sections' ranges, so disjoint sections leave the gap out
	it("reads only the union of disjoint pointed PDF sections", async () => {
		const specs: Array<string | undefined> = [];
		const worker = createBookRouteWorker({
			engineFor: () => fauxEngine([]),
			runPdfReader: async (input) => {
				specs.push(input.pages);
				return {
					path: input.path,
					question: input.question,
					brief: JSON.stringify({ pages: "p. 10", method: "m" }),
					pagesRead: [10],
					pagesConsulted: [10],
				};
			},
		});
		await worker(makeInput({ sectionIds: ["s1", "s3"] }));
		assert.equal(specs.length, 1);
		assert.deepEqual(parsePageSpec(specs[0]!, 100), [...range(10, 15), ...range(30, 40)]);
	});

	// plan 020 part 3: text reference files get only the pointed line ranges, disjoint ranges included
	it("slices disjoint pointed line ranges of a text reference file and leaves the gap out", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-route-"));
		const prevHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const filePath = path.join(dir, "book.md");
			fs.writeFileSync(filePath, ["First A", "First B", "Gap C", "Gap D", "Last E", "Last F"].join("\n"), "utf8");
			const engine = fauxEngine([fauxAssistantMessage([fauxText(JSON.stringify({ pages: "l", method: "m" }))])]);
			const seen: string[] = [];
			const origStream = engine.streamFn;
			engine.streamFn = (model, context, options) => {
				const last = context.messages[context.messages.length - 1];
				seen.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
				return origStream(model, context, options);
			};
			const worker = createBookRouteWorker({ engineFor: () => engine });
			await worker(
				makeInput({
					path: filePath,
					sectionIds: ["s1", "s3"],
					sections: [
						{ id: "s1", title: "A", level: 1, startPage: 1, endPage: 2 },
						{ id: "s2", title: "B", level: 1, startPage: 3, endPage: 4 },
						{ id: "s3", title: "C", level: 1, startPage: 5, endPage: 6 },
					],
					referenceFrom: "headings",
				}),
			);
			assert.equal(seen.length, 1);
			assert.ok(seen[0]!.includes("First A"));
			assert.ok(seen[0]!.includes("Last F"));
			assert.ok(!seen[0]!.includes("Gap C"));
			assert.ok(!seen[0]!.includes("Gap D"));
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// plan 020 part 3: one repair attempt when method > BOOK_ROUTE_CAP or JSON has problems
	it("performs one repair attempt when method exceeds BOOK_ROUTE_CAP, then fails if still invalid", async () => {
		const overCap = "a".repeat(BOOK_ROUTE_CAP + 1);
		let attempt = 0;
		const workerOk = createBookRouteWorker({
			engineFor: () => fauxEngine([]),
			runPdfReader: async (input) => {
				attempt++;
				return {
					path: input.path,
					question: input.question,
					brief: attempt === 1
						? JSON.stringify({ pages: "p. 10", method: overCap })
						: JSON.stringify({ pages: "p. 10", method: "Trimmed route (p. 10)." }),
					pagesRead: [10],
					pagesConsulted: [10],
				};
			},
		});

		const repaired = await workerOk(makeInput());
		assert.equal(attempt, 2);
		assert.deepEqual(repaired, { ok: true, pages: "p. 10", method: "Trimmed route (p. 10)." });

		let badAttempts = 0;
		const workerFail = createBookRouteWorker({
			engineFor: () => fauxEngine([]),
			runPdfReader: async (input) => {
				badAttempts++;
				return {
					path: input.path,
					question: input.question,
					brief: JSON.stringify({ pages: "p. 10", method: overCap }),
					pagesRead: [10],
					pagesConsulted: [10],
				};
			},
		});

		const failed = await workerFail(makeInput());
		assert.equal(badAttempts, 2);
		assert.equal(failed.ok, false);
	});

	// plan 020 part 3: {"pages":"","method":""} is stored as failed route with error "not covered"
	it("returns error 'not covered' when the model returns empty pages and method", async () => {
		const worker = createBookRouteWorker({
			engineFor: () => fauxEngine([]),
			runPdfReader: async (input) => ({
				path: input.path,
				question: input.question,
				brief: JSON.stringify({ pages: "", method: "" }),
				pagesRead: [10],
				pagesConsulted: [10],
			}),
		});

		const outcome = await worker(makeInput());
		assert.deepEqual(outcome, { ok: false, error: "not covered" });
	});

	// plan 020 part 3: the normalized context carries the instructions as a system message
	it("sends the confirmed instructions as the system message on the text path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-route-sys-"));
		try {
			const filePath = path.join(dir, "book.md");
			fs.writeFileSync(filePath, ["# One", "Derivation line 2", "## Two"].join("\n"), "utf8");
			const engine = fauxEngine([fauxAssistantMessage([fauxText(JSON.stringify({ pages: "lines 1-2", method: "From line 2." }))])]);
			const seen: string[] = [];
			const origStream = engine.streamFn;
			engine.streamFn = (model, context, options) => {
				seen.push(JSON.stringify(context.messages));
				return origStream(model, context, options);
			};
			const worker = createBookRouteWorker({ engineFor: () => engine });
			const outcome = await worker(
				makeInput({
					path: filePath,
					sectionIds: ["s1"],
					sections: [{ id: "s1", title: "One", level: 1, startPage: 1, endPage: 2 }],
					referenceFrom: "headings",
				}),
			);
			assert.equal(outcome.ok, true);
			assert.equal(seen.length, 1);
			assert.ok(seen[0]!.includes("You read sections of a reference book for one plan node"));
			assert.ok(seen[0]!.includes("Derivation line 2"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
