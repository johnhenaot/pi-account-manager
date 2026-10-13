import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Account, accountId } from "../src/account.ts";
import { loadAccounts, parseState, saveAccounts, statePath } from "../src/state.ts";
import { cleanupAgentDir, makeAgentDir, readStateFile, writeStateFile } from "./helpers.ts";

let agentDir: string;

beforeEach(async () => {
	agentDir = await makeAgentDir();
});

afterEach(async () => {
	await cleanupAgentDir(agentDir);
});

describe("state schema", () => {
	it("accepts a valid file and sorts by provider then name", () => {
		const parsed = parseState(
			JSON.stringify({
				version: 1,
				accounts: [
					{ provider: "openai-codex", name: "personal" },
					{ provider: "anthropic", name: "work" },
					{ provider: "anthropic", name: "alt" },
				],
			}),
		);
		expect(parsed.map(accountId)).toEqual(["anthropic@alt", "anthropic@work", "openai-codex@personal"]);
	});

	it("rejects malformed files instead of recovering partially", () => {
		const cases: [string, string][] = [
			["not json", "not valid JSON"],
			["[]", '{"version": 1'],
			['{"version":2,"accounts":[]}', '{"version": 1'],
			['{"version":1,"accounts":{}}', '{"version": 1'],
			['{"version":1,"accounts":[[]]}', "unsupported provider"],
			['{"version":1,"accounts":[{"provider":"unsupported","name":"work"}]}', "unsupported provider"],
			['{"version":1,"accounts":[{"provider":"toString","name":"work"}]}', "unsupported provider"],
			['{"version":1,"accounts":[{"provider":"anthropic"}]}', "invalid account name"],
			['{"version":1,"accounts":[{"provider":"anthropic","name":"Work"}]}', "invalid account name"],
			[
				'{"version":1,"accounts":[{"provider":"anthropic","name":"work"},{"provider":"anthropic","name":"work"}]}',
				"duplicate account",
			],
		];
		for (const [body, fragment] of cases) expect(() => parseState(body), body).toThrow(fragment);
	});
});

describe("load and save", () => {
	it("treats a missing file as no accounts", async () => {
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});

	it("surfaces a corrupt file as a load error", async () => {
		await writeStateFile(agentDir, "{ nope");
		await expect(loadAccounts(agentDir)).rejects.toThrow("not valid JSON");
	});

	it("round-trips sorted, in the version 1 shape, leaving no temp file", async () => {
		const accounts: Account[] = [
			{ provider: "openai-codex", name: "work" },
			{ provider: "anthropic", name: "work" },
			{ provider: "openai", name: "work" },
		];
		await saveAccounts(agentDir, accounts);
		const sorted = [accounts[1], accounts[2], accounts[0]];
		expect(JSON.parse(await readStateFile(agentDir))).toEqual({ version: 1, accounts: sorted });
		expect(await loadAccounts(agentDir)).toEqual(sorted);
		expect(await readdir(dirname(statePath(agentDir)))).toEqual(["accounts.json"]);
	});
});
