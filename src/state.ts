import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Account, accountId, isProviderId, isValidName, sortAccounts } from "./account.ts";

export const statePath = (agentDir: string): string => join(agentDir, "pi-account-manager", "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseState(text: string): Account[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("accounts.json is not valid JSON.");
	}
	if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.accounts))
		throw new Error('accounts.json must be {"version": 1, "accounts": [...]}.');
	const accounts: Account[] = [];
	for (const entry of raw.accounts) {
		const { provider, name } = isRecord(entry) ? entry : {};
		if (typeof provider !== "string" || !isProviderId(provider))
			throw new Error(`accounts.json has unsupported provider ${JSON.stringify(provider)}.`);
		if (typeof name !== "string" || !isValidName(name))
			throw new Error(`accounts.json has invalid account name ${JSON.stringify(name)}.`);
		const account = { provider, name };
		if (accounts.some((other) => accountId(other) === accountId(account)))
			throw new Error(`accounts.json has duplicate account ${accountId(account)}.`);
		accounts.push(account);
	}
	return sortAccounts(accounts);
}

export async function loadAccounts(agentDir: string): Promise<Account[]> {
	try {
		return parseState(await readFile(statePath(agentDir), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function writeAtomically(path: string, text: string): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, text, "utf8");
	await rename(temp, path);
}

// shortcut: no lock, so two pi processes saving at the same instant can lose one change; add a lock file if it happens.
export async function saveAccounts(agentDir: string, accounts: readonly Account[]): Promise<void> {
	const path = statePath(agentDir);
	await mkdir(dirname(path), { recursive: true });
	await writeAtomically(path, `${JSON.stringify({ version: 1, accounts: sortAccounts(accounts) }, null, 2)}\n`);
}
