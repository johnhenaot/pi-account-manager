import { describe, expect, it } from "vitest";
import { type Account, accountId, isProviderId, isValidName, normalizeName, sortAccounts } from "../src/account.ts";

describe("names", () => {
	it("normalizes with trim then ASCII lowercasing", () => {
		expect(normalizeName("  Work  ")).toBe("work");
		expect(normalizeName("WORK_1-a")).toBe("work_1-a");
	});

	it("leaves non-ASCII uppercase alone, so a lookalike fails validation instead of folding into an ASCII name", () => {
		const kelvinSign = "\u212A";
		expect(kelvinSign.toLowerCase()).toBe("k");
		expect(normalizeName(`${kelvinSign}ate`)).toBe(`${kelvinSign}ate`);
		expect(isValidName(normalizeName(`${kelvinSign}ate`))).toBe(false);
	});

	it("validates against the documented pattern", () => {
		for (const valid of ["a", "0", "work", "work-2", "my_account", "a".repeat(32)]) {
			expect(isValidName(valid), valid).toBe(true);
		}
		for (const invalid of ["", "-work", "_work", "Work", "work name", "work.dev", "a".repeat(33), "work@x"]) {
			expect(isValidName(invalid), invalid).toBe(false);
		}
	});
});

describe("alias identity", () => {
	it("derives alias IDs", () => {
		expect(accountId({ provider: "anthropic", name: "work" })).toBe("anthropic@work");
		expect(accountId({ provider: "openai-codex", name: "personal" })).toBe("openai-codex@personal");
		expect(isProviderId("openai")).toBe(true);
		expect(isProviderId("toString")).toBe(false);
	});

	it("allows the same name once per provider", () => {
		const accounts: Account[] = [
			{ provider: "anthropic", name: "work" },
			{ provider: "openai", name: "work" },
			{ provider: "openai-codex", name: "work" },
		];
		expect(new Set(accounts.map(accountId)).size).toBe(3);
	});
});

describe("ordering", () => {
	const accounts: Account[] = [
		{ provider: "openai-codex", name: "personal" },
		{ provider: "anthropic", name: "work" },
		{ provider: "anthropic", name: "alt" },
		{ provider: "openai", name: "work" },
	];

	it("sorts by provider ID then name, which also matches display labels", () => {
		expect(sortAccounts(accounts).map(accountId)).toEqual([
			"anthropic@alt",
			"anthropic@work",
			"openai@work",
			"openai-codex@personal",
		]);
	});

	it("orders names by code unit rather than by locale, so the saved order is the same on every platform", () => {
		const hyphenBeforeUnderscore: Account[] = [
			{ provider: "anthropic", name: "a_b" },
			{ provider: "anthropic", name: "a-b" },
		];
		expect(sortAccounts(hyphenBeforeUnderscore).map(accountId)).toEqual(["anthropic@a-b", "anthropic@a_b"]);
	});

	it("does not mutate its input", () => {
		const original = [...accounts];
		sortAccounts(accounts);
		expect(accounts).toEqual(original);
	});
});
