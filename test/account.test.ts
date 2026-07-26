import { describe, expect, it } from "vitest";
import {
	type Account,
	accountId,
	aliasDisplayName,
	aliasId,
	isValidName,
	normalizeName,
	sortForDisplay,
	sortForPersistence,
} from "../src/account.ts";

describe("names", () => {
	it("normalizes with trim then ASCII lowercasing only", () => {
		expect(normalizeName("  Work  ")).toBe("work");
		expect(normalizeName("WORK_1-a")).toBe("work_1-a");
		// Non-ASCII uppercase is left alone, so it fails validation rather than folding.
		expect(normalizeName("İstanbul")).toBe("İstanbul");
		expect(isValidName(normalizeName("İstanbul"))).toBe(false);
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
	it("derives alias IDs and display names", () => {
		expect(aliasId("anthropic", "work")).toBe("anthropic@work");
		expect(aliasId("openai-codex", "personal")).toBe("openai-codex@personal");
		expect(aliasDisplayName("anthropic", "work")).toBe("Anthropic (work)");
		expect(aliasDisplayName("openai-codex", "personal")).toBe("OpenAI Codex (personal)");
	});

	it("allows the same name once per provider", () => {
		const accounts: Account[] = [
			{ provider: "anthropic", name: "work" },
			{ provider: "openai-codex", name: "work" },
		];
		expect(new Set(accounts.map(accountId)).size).toBe(2);
	});
});

describe("ordering", () => {
	const accounts: Account[] = [
		{ provider: "openai-codex", name: "personal" },
		{ provider: "anthropic", name: "work" },
		{ provider: "anthropic", name: "alt" },
	];

	it("persists by provider ID then name", () => {
		expect(sortForPersistence(accounts).map(accountId)).toEqual([
			"anthropic@alt",
			"anthropic@work",
			"openai-codex@personal",
		]);
	});

	it("displays by provider display name then name", () => {
		expect(sortForDisplay(accounts).map(accountId)).toEqual([
			"anthropic@alt",
			"anthropic@work",
			"openai-codex@personal",
		]);
	});

	it("does not mutate its input", () => {
		const original = [...accounts];
		sortForPersistence(accounts);
		sortForDisplay(accounts);
		expect(accounts).toEqual(original);
	});
});
