import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import { pdfInputSchema } from "../src/agent/tools/jobs.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("reference pdf pages", () => {
	// plan 012 part 4: pdf job input gains pages?: string (spec)
	it("includes optional pages in pdfInputSchema", () => {
		assert.ok("pages" in pdfInputSchema.properties);
	});

	// plan 012 part 4: reader prompt says "Read within pages <spec> (the section the teacher points to); widen only if the answer is clearly outside."
	it("includes the scoped-pages instruction in the reader prompt only when pages is provided", async () => {
		let scopedUserPrompt = "";
		const scopedEngine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Force is on page 2 (p. 2).")]),
		]);
		const baseScopedStream = scopedEngine.streamFn;
		scopedEngine.streamFn = (...args) => {
			if (!scopedUserPrompt) {
				const firstUser = args[1].messages.find((m) => m.role === "user");
				scopedUserPrompt = typeof firstUser?.content === "string"
					? firstUser.content
					: (firstUser?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			}
			return baseScopedStream(...args);
		};

		await runPdfReaderAgent({ path: FIXTURE, question: "Explain force", pages: "2-3" }, { engine: scopedEngine });
		assert.ok(
			scopedUserPrompt.includes("Read within pages 2-3 (the section the teacher points to); widen only if the answer is clearly outside."),
		);

		let unscopedUserPrompt = "";
		const unscopedEngine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Calculus is on page 1 (p. 1).")]),
		]);
		const baseUnscopedStream = unscopedEngine.streamFn;
		unscopedEngine.streamFn = (...args) => {
			if (!unscopedUserPrompt) {
				const firstUser = args[1].messages.find((m) => m.role === "user");
				unscopedUserPrompt = typeof firstUser?.content === "string"
					? firstUser.content
					: (firstUser?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			}
			return baseUnscopedStream(...args);
		};

		await runPdfReaderAgent({ path: FIXTURE, question: "Explain calculus" }, { engine: unscopedEngine });
		assert.ok(!unscopedUserPrompt.includes("Read within pages"));
	});

	it("skips the scoped-pages instruction for a whitespace-only pages value", async () => {
		let userPrompt = "";
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Calculus is on page 1 (p. 1).")]),
		]);
		const baseStream = engine.streamFn;
		engine.streamFn = (...args) => {
			if (!userPrompt) {
				const firstUser = args[1].messages.find((m) => m.role === "user");
				userPrompt = typeof firstUser?.content === "string"
					? firstUser.content
					: (firstUser?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			}
			return baseStream(...args);
		};

		await runPdfReaderAgent({ path: FIXTURE, question: "Explain calculus", pages: "   " }, { engine });
		assert.ok(!userPrompt.includes("Read within pages"));
	});

	// plan 012 part 4: pdf_info reports only those pages when pages is provided
	it("scopes pdf_info output to the requested pages when pages is provided", async () => {
		let scopedContext = "";
		const scopedEngine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Force on page 2 (p. 2).")]),
		]);
		const baseScopedStream = scopedEngine.streamFn;
		scopedEngine.streamFn = (...args) => {
			scopedContext = JSON.stringify(args[1]);
			return baseScopedStream(...args);
		};

		await runPdfReaderAgent({ path: FIXTURE, question: "Explain force", pages: "2-3" }, { engine: scopedEngine });
		assert.ok(scopedContext.includes("p2:"));
		assert.ok(scopedContext.includes("p3:"));
		assert.ok(!scopedContext.includes("p1:"));

		let fullContext = "";
		const fullEngine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Calculus on page 1 (p. 1).")]),
		]);
		const baseFullStream = fullEngine.streamFn;
		fullEngine.streamFn = (...args) => {
			fullContext = JSON.stringify(args[1]);
			return baseFullStream(...args);
		};

		await runPdfReaderAgent({ path: FIXTURE, question: "Explain calculus" }, { engine: fullEngine });
		assert.ok(fullContext.includes("p1:"));
		assert.ok(fullContext.includes("p2:"));
		assert.ok(fullContext.includes("p3:"));
	});

	// plan 012 part 4: runner.ts forwards optional pages from PdfToolInput to runPdfReaderAgent
	it("forwards pages from PdfToolInput through createJobRunner", async () => {
		let firstUserPrompt = "";
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Force on page 2 (p. 2).")]),
		]);
		const baseStream = engine.streamFn;
		engine.streamFn = (...args) => {
			if (!firstUserPrompt) {
				const firstUser = args[1].messages.find((m) => m.role === "user");
				firstUserPrompt = typeof firstUser?.content === "string"
					? firstUser.content
					: (firstUser?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			}
			return baseStream(...args);
		};

		const job: JobRecord = {
			id: "job_1",
			kind: "pdf",
			chatId: "chat_1",
			toolCallId: "tc_1",
			input: { path: FIXTURE, question: "Explain force", pages: "2" },
			status: "running",
			activity: "queued",
			createdAt: "2026-11-24T00:00:00.000Z",
			updatedAt: "2026-11-24T00:00:00.000Z",
		};
		const jobStore: Pick<JobStore, "getJob" | "updateJob"> = {
			getJob: (id) => (id === job.id ? job : null),
			updateJob: (_id, patch) => {
				Object.assign(job, patch);
				return job;
			},
		};
		const runner = createJobRunner({
			chatStore: { getChat: (id: string) => (id === job.chatId ? ({ id, messages: [] } as never) : null) } as unknown as ChatStore,
			jobStore: jobStore as JobStore,
			deliver: async () => {},
			engineFor: () => engine,
		});

		await runner.runJob(job.id, { path: FIXTURE, question: "Explain force", pages: "2" });
		assert.ok(
			firstUserPrompt.includes("Read within pages 2 (the section the teacher points to); widen only if the answer is clearly outside."),
		);
	});
});
