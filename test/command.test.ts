import { describe, expect, it } from "vitest";
import type { Account } from "../src/account.ts";
import { parseCommand, resolveRemoveTarget, USAGE } from "../src/command.ts";
import { EMPTY_LIST, formatList } from "../src/list.ts";

describe("parseCommand", () => {
	it("accepts every documented form", () => {
		expect(parseCommand("")).toEqual({ kind: "list" });
		expect(parseCommand("   ")).toEqual({ kind: "list" });
		expect(parseCommand("list")).toEqual({ kind: "list" });
		expect(parseCommand("add")).toEqual({ kind: "add", name: undefined });
		expect(parseCommand("add work")).toEqual({ kind: "add", name: "work" });
		expect(parseCommand("remove")).toEqual({ kind: "remove", target: undefined });
		expect(parseCommand("remove anthropic@work")).toEqual({ kind: "remove", target: "anthropic@work" });
	});

	it("shows usage for unknown subcommands and excess arguments", () => {
		for (const args of ["status", "ADD work", "list extra", "add a b", "remove a b", "add work extra"]) {
			expect(parseCommand(args), args).toEqual({ kind: "usage" });
		}
		expect(USAGE).toContain("/account add [name]");
	});
});

describe("resolveRemoveTarget", () => {
	const anthropicWork: Account = { provider: "anthropic", name: "work" };
	const codexWork: Account = { provider: "openai-codex", name: "work" };
	const codexPersonal: Account = { provider: "openai-codex", name: "personal" };
	const all = [codexPersonal, codexWork, anthropicWork];

	it("offers every loaded account when no argument is given", () => {
		expect(resolveRemoveTarget(all, undefined)).toEqual({
			kind: "choose",
			accounts: [anthropicWork, codexPersonal, codexWork],
		});
		expect(resolveRemoveTarget([], undefined)).toEqual({ kind: "none" });
	});

	it("prefers an exact case-sensitive alias ID", () => {
		expect(resolveRemoveTarget(all, "openai-codex@work")).toEqual({ kind: "one", account: codexWork });
		// Wrong case is not an alias ID, and is not a valid name either.
		expect(resolveRemoveTarget(all, "OpenAI-Codex@work")).toEqual({ kind: "none" });
	});

	it("falls back to a normalized name match", () => {
		expect(resolveRemoveTarget(all, " PERSONAL ")).toEqual({ kind: "one", account: codexPersonal });
		expect(resolveRemoveTarget(all, "work")).toEqual({ kind: "choose", accounts: [anthropicWork, codexWork] });
	});

	it("resolves nothing for invalid input or a miss", () => {
		expect(resolveRemoveTarget(all, "not a name")).toEqual({ kind: "none" });
		expect(resolveRemoveTarget(all, "missing")).toEqual({ kind: "none" });
	});
});

describe("formatList", () => {
	it("orders by provider display name then account name", () => {
		const rows = formatList(
			[
				{ provider: "openai-codex", name: "work" },
				{ provider: "anthropic", name: "work" },
				{ provider: "anthropic", name: "alt" },
			],
			() => "authenticated",
		).split("\n");
		expect(rows[0]).toMatch(/^NAME\s+PROVIDER\s+ALIAS ID\s+STATUS$/);
		expect(rows.slice(1).map((row) => row.split(/\s{2,}/)[2])).toEqual([
			"anthropic@alt",
			"anthropic@work",
			"openai-codex@work",
		]);
	});

	it("shows every status verbatim", () => {
		const statuses = ["authenticated", "not authenticated", "status unavailable"];
		const text = formatList(
			statuses.map((_, index) => ({ provider: "anthropic" as const, name: `a${index}` })),
			(account) => statuses[Number(account.name.slice(1))],
		);
		for (const status of statuses) expect(text).toContain(status);
	});

	it("has an exact empty message", () => {
		expect(formatList([], () => "authenticated")).toBe("No named accounts. Use /account add NAME.");
		expect(EMPTY_LIST).toBe("No named accounts. Use /account add NAME.");
	});
});
