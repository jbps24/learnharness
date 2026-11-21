import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { composeInstructions, type AgentKind } from "../src/agent/teacher-agent.ts";

const PROMPTS_DIR = path.resolve(import.meta.dirname, "../src/agent/prompts");
const PRONOUN_RE = /\b(he|him|his|himself)\b/i;

function collectMarkdownFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectMarkdownFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

describe("prompt units doctrine and neutral pronouns", () => {
	// plan 001 part 7: composeInstructions("teacher") contains subgraph, %% source: and unit
	it("teacher prompt includes subgraph, %% source:, and unit", () => {
		const teacher = composeInstructions("teacher");
		assert.ok(teacher.includes("subgraph"), "teacher prompt must include subgraph");
		assert.ok(teacher.includes("%% source:"), "teacher prompt must include %% source:");
		assert.ok(teacher.includes("unit"), "teacher prompt must include unit");
	});

	// plan 001 part 7: prober prompt does not mention units
	it("prober prompt does not mention units", () => {
		const prober = composeInstructions("prober");
		assert.doesNotMatch(prober, /\bunits?\b/i, "prober prompt must not mention units");
	});

	// plan 001 part 7: composeInstructions(k) for prober, teacher, practice match no whole-word /\b(he|him|his|himself)\b/i
	it("composed instructions for prober, teacher, and practice contain no he/him/his/himself", () => {
		const kinds: AgentKind[] = ["prober", "teacher", "practice"];
		for (const kind of kinds) {
			assert.doesNotMatch(
				composeInstructions(kind),
				PRONOUN_RE,
				`composeInstructions("${kind}") must not match ${PRONOUN_RE}`,
			);
		}
	});

	// plan 001 part 7: raw text of every .md file under src/agent/prompts/ matches no whole-word /\b(he|him|his|himself)\b/i
	it("raw text of every .md file under src/agent/prompts/ contains no he/him/his/himself", () => {
		const files = collectMarkdownFiles(PROMPTS_DIR);
		assert.ok(files.length > 0, "expected markdown files under src/agent/prompts/");
		for (const file of files) {
			const rel = path.relative(PROMPTS_DIR, file);
			const text = fs.readFileSync(file, "utf-8");
			assert.doesNotMatch(text, PRONOUN_RE, `${rel} must not match ${PRONOUN_RE}`);
		}
	});
});
