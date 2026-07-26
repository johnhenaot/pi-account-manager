import { readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Account, accountId, sortForPersistence } from "../src/account.ts";
import {
	loadAccounts,
	mutateAccounts,
	parseState,
	serializeState,
	STALE_SNAPSHOT_MESSAGE,
	statePath,
} from "../src/state.ts";
import { cleanupAgentDir, makeAgentDir, readStateFile, writeStateFile } from "./helpers.ts";

let agentDir: string;

beforeEach(async () => {
	agentDir = await makeAgentDir();
});

afterEach(async () => {
	await cleanupAgentDir(agentDir);
});

describe("state schema", () => {
	it("accepts a valid file and canonicalizes by provider then name", () => {
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

	it("round-trips through the exact version 1 shape", () => {
		const accounts: Account[] = [{ provider: "anthropic", name: "work" }];
		expect(JSON.parse(serializeState(accounts))).toEqual({ version: 1, accounts });
		expect(parseState(serializeState(accounts))).toEqual(accounts);
	});

	it("rejects every malformed shape instead of recovering partially", () => {
		const cases: [string, string][] = [
			["not json", "not valid JSON"],
			["[]", "must contain a JSON object"],
			['{"version":1}', "exactly"],
			['{"version":1,"accounts":[],"extra":1}', "exactly"],
			['{"version":2,"accounts":[]}', "unsupported version"],
			['{"version":1,"accounts":{}}', "must be an array"],
			['{"version":1,"accounts":[[]]}', "not an object"],
			['{"version":1,"accounts":[{"provider":"anthropic"}]}', "exactly"],
			['{"version":1,"accounts":[{"provider":"anthropic","name":"work","extra":1}]}', "exactly"],
			['{"version":1,"accounts":[{"provider":"openai","name":"work"}]}', "unsupported provider"],
			['{"version":1,"accounts":[{"provider":"anthropic","name":"Work"}]}', "invalid account name"],
			['{"version":1,"accounts":[{"provider":"anthropic","name":"-bad"}]}', "invalid account name"],
			[
				'{"version":1,"accounts":[{"provider":"anthropic","name":"work"},{"provider":"anthropic","name":"work"}]}',
				"duplicate account",
			],
		];
		for (const [body, fragment] of cases) {
			expect(() => parseState(body), body).toThrow(fragment);
		}
	});

	it("treats a missing file as an empty account set", async () => {
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});

	it("surfaces a corrupt file as a load error", async () => {
		await writeStateFile(agentDir, "{ nope");
		await expect(loadAccounts(agentDir)).rejects.toThrow("not valid JSON");
	});
});

describe("mutateAccounts", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	it("adds atomically and reports the new canonical set", async () => {
		const next = await mutateAccounts(agentDir, [], (accounts) => [...accounts, work]);
		expect(next).toEqual([work]);
		expect(JSON.parse(await readStateFile(agentDir))).toEqual({ version: 1, accounts: [work] });
	});

	it("removes atomically", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const next = await mutateAccounts(agentDir, [work], (accounts) =>
			accounts.filter((a) => accountId(a) !== "anthropic@work"),
		);
		expect(next).toEqual([]);
		expect(JSON.parse(await readStateFile(agentDir))).toEqual({ version: 1, accounts: [] });
	});

	it("never publishes the new state when the runtime half of the update fails", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		await expect(
			mutateAccounts(
				agentDir,
				[],
				(accounts) => [...accounts, work],
				() => {
					throw new Error("registration failed");
				},
			),
		).rejects.toThrow("registration failed");
		expect(JSON.parse(await readStateFile(agentDir))).toEqual({ version: 1, accounts: [] });
	});

	it("leaves no staging file behind when the runtime half fails", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		await expect(
			mutateAccounts(
				agentDir,
				[],
				(accounts) => [...accounts, work],
				() => {
					throw new Error("registration failed");
				},
			),
		).rejects.toThrow("registration failed");
		const left = (await readdir(join(agentDir, "pi-account-manager"))).filter((f) => f.endsWith(".tmp"));
		expect(left).toEqual([]);
	});

	it("keeps the old state readable to other processes while a commit is pending", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		let seenByAnotherProcess: Account[] | undefined;
		await expect(
			mutateAccounts(
				agentDir,
				[],
				(accounts) => [...accounts, work],
				() => {
					// Stands in for a second pi process loading state mid-mutation.
					seenByAnotherProcess = parseState(readFileSync(statePath(agentDir), "utf8"));
					throw new Error("registration failed");
				},
			),
		).rejects.toThrow("registration failed");
		expect(seenByAnotherProcess, "tentative state must not be visible").toEqual([]);
	});

	it("maps an unparseable authoritative file to the /reload recovery path", async () => {
		// The spec's own example of a semantic difference is a duplicate appearing, which
		// fails the parse rather than the snapshot comparison.
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "anthropic", name: "work" }],
		});
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow(STALE_SNAPSHOT_MESSAGE);

		await writeStateFile(agentDir, "{ broken");
		const failure = mutateAccounts(agentDir, [], (accounts) => accounts);
		await expect(failure).rejects.toThrow(STALE_SNAPSHOT_MESSAGE);
		await expect(failure).rejects.toThrow("not valid JSON");
	});

	it("aborts with a /reload instruction when a record appeared behind our back", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow(STALE_SNAPSHOT_MESSAGE);
	});

	it("aborts when the removal target disappeared behind our back", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		await expect(mutateAccounts(agentDir, [work], (accounts) => accounts.filter(() => false))).rejects.toThrow(
			STALE_SNAPSHOT_MESSAGE,
		);
	});

	it("serializes concurrent writers without losing an update", async () => {
		const names = ["one", "two", "three", "four", "five"];
		// Each writer rereads under the lock, so all but one see a stale snapshot and abort.
		const results = await Promise.allSettled(
			names.map((name) => mutateAccounts(agentDir, [], (accounts) => [...accounts, { provider: "anthropic", name }])),
		);
		expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
		for (const rejected of results.filter((r) => r.status === "rejected")) {
			expect((rejected as PromiseRejectedResult).reason.message).toContain(STALE_SNAPSHOT_MESSAGE);
		}
		// Never a partial or duplicated persistent state.
		const persisted = parseState(await readStateFile(agentDir));
		expect(persisted).toEqual(sortForPersistence(persisted));
		expect(new Set(persisted.map(accountId)).size).toBe(persisted.length);
	});

	it("fails from lock contention within five seconds rather than hanging", async () => {
		await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
		await writeFile(join(agentDir, "pi-account-manager", "accounts.lock"), "", "utf8");
		const started = Date.now();
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow(
			"timed out waiting for the account state lock",
		);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(4_000);
		expect(elapsed).toBeLessThan(9_000);
	}, 20_000);

	it("names the lock file so a stuck lock is recoverable by hand", async () => {
		await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
		const lockPath = join(agentDir, "pi-account-manager", "accounts.lock");
		await writeFile(lockPath, "", "utf8");
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow(lockPath);
	}, 20_000);

	it("releases the lock after a successful update", async () => {
		await mutateAccounts(agentDir, [], (accounts) => [...accounts, work]);
		// A second mutation would time out if the first had leaked its lock.
		await expect(mutateAccounts(agentDir, [work], (accounts) => accounts)).resolves.toEqual([work]);
	});

	it("releases the lock after a failed update", async () => {
		await expect(
			mutateAccounts(agentDir, [], () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(mutateAccounts(agentDir, [], (accounts) => [...accounts, work])).resolves.toEqual([work]);
	});
});
