import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/index.ts";
import { spanKeyOf } from "../src/server/unit-cut.ts";

const user = (id: string) => ({ id, role: "user", content: id, timestamp: 1 }) as unknown as LhMessage;
const custom = (id: string, customType: string) =>
	({ id, role: "custom", customType, content: id, display: false, timestamp: 1 }) as unknown as LhMessage;

describe("spanKeyOf marker filtering", () => {
	it("drops the listed marker types but keeps other custom messages and plain ones", () => {
		const messages = [
			user("u1"),
			custom("m1", "course-files"),
			custom("m2", "course-method"),
			custom("m3", "units-note"),
			custom("keep", "some-other-custom"),
			user("u2"),
		];
		assert.equal(spanKeyOf(messages, 0, messages.length, "rec"), "rec|u1|keep|u2");
	});
});
