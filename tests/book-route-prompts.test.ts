import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const PROMPT_PATH = path.resolve(import.meta.dirname, "../src/agent/prompts/shared/30-learner-files.md");

const CONFIRMED_PARAGRAPH =
	'Course material is either complete (a script or a Mitschrift: it sets what is learned and how) or an overview (marked "(overview)" in the [Course material] note, usually slides: it sets what is learned, the order, the results and the notation, but not how to get there). For an overview node, the [Course method] note also carries a book route: the derivation from the book the course was built from. Teach, check and grade that derivation as the course\'s route, in the overview\'s notation. Where an overview node has no book route, fill the steps as described above and say so.';

const UPDATED_REFERENCE_SENTENCE =
	"Where a reference uses another route or notation, the course material wins, except for the book routes in [Course method] notes; translate into the course material's notation.";

const OLD_REFERENCE_SENTENCE =
	"Where a reference uses another route or notation, the course material wins; translate into its notation.";

describe("30-learner-files.md book-route prompt updates", () => {
	// plan 020 part 4: confirmed prompt paragraph goes after the first paragraph in Course material of 30-learner-files.md
	it("places the confirmed Overview/Complete paragraph after the first paragraph of Course material", () => {
		const content = fs.readFileSync(PROMPT_PATH, "utf8");
		const sectionStart = content.indexOf("## Course material");
		assert.ok(sectionStart >= 0, "Expected ## Course material section");
		const section = content.slice(sectionStart);
		const paragraphs = section.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
		// paragraphs[0] is heading "## Course material", paragraphs[1] is the first paragraph, paragraphs[2] is the new paragraph
		assert.equal(paragraphs[2], CONFIRMED_PARAGRAPH);
		assert.ok(paragraphs[3]?.startsWith("Files in a [Reference] note"));
	});

	// plan 020 part 4: [Reference] paragraph sentence updated for book routes in [Course method] notes
	it("updates the [Reference] notation sentence to except book routes in [Course method] notes", () => {
		const content = fs.readFileSync(PROMPT_PATH, "utf8");
		assert.ok(content.includes(UPDATED_REFERENCE_SENTENCE));
		assert.ok(!content.includes(OLD_REFERENCE_SENTENCE));
	});
});
