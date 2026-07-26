import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Account, aliasId, isProviderId, isValidName, normalizeName, sortForPersistence } from "./account.ts";

export const stateDir = (agentDir: string): string => join(agentDir, "pi-account-manager");
export const statePath = (agentDir: string): string => join(stateDir(agentDir), "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
};

export function parseState(text: string): Account[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("accounts.json is not valid JSON.");
	}
	if (!isRecord(raw)) throw new Error("accounts.json must contain a JSON object.");
	if (!hasExactKeys(raw, ["accounts", "version"]))
		throw new Error('accounts.json must contain exactly "version" and "accounts".');
	if (raw.version !== 1) throw new Error(`accounts.json has unsupported version ${JSON.stringify(raw.version)}.`);
	if (!Array.isArray(raw.accounts)) throw new Error('accounts.json "accounts" must be an array.');

	const seen = new Set<string>();
	const accounts: Account[] = [];
	for (const entry of raw.accounts) {
		if (!isRecord(entry)) throw new Error("accounts.json has an account entry that is not an object.");
		if (!hasExactKeys(entry, ["name", "provider"]))
			throw new Error('each account must contain exactly "provider" and "name".');
		const { provider, name } = entry;
		if (typeof provider !== "string" || !isProviderId(provider))
			throw new Error(`accounts.json has unsupported provider ${JSON.stringify(provider)}.`);
		if (typeof name !== "string" || normalizeName(name) !== name || !isValidName(name))
			throw new Error(`accounts.json has invalid account name ${JSON.stringify(name)}.`);
		const id = aliasId(provider, name);
		if (seen.has(id)) throw new Error(`accounts.json has duplicate account ${id}.`);
		seen.add(id);
		accounts.push({ provider, name });
	}
	return sortForPersistence(accounts);
}

export const serializeState = (accounts: readonly Account[]): string =>
	`${JSON.stringify({ version: 1, accounts: sortForPersistence(accounts) }, null, 2)}\n`;

export async function loadAccounts(agentDir: string): Promise<Account[]> {
	const path = statePath(agentDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		// A missing file means no named accounts yet; anything else is a real load error.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseState(text);
}

async function writeState(agentDir: string, accounts: readonly Account[]): Promise<void> {
	const target = statePath(agentDir);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, serializeState(accounts), "utf8");
	try {
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Contention resolves or fails inside this window. */
export const LOCK_TIMEOUT_MS = 5000;
export const STALE_SNAPSHOT_MESSAGE = "named accounts changed in another process. Run /reload, then try again.";

/**
 * The lock closes the read-modify-write window below, which is the only thing standing
 * between two simultaneous writers and a silently lost update. Atomic rename covers
 * partial reads on its own.
 */
async function withLock<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
	const dir = stateDir(agentDir);
	await mkdir(dir, { recursive: true });
	const lockPath = join(dir, "accounts.lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			await (await open(lockPath, "wx")).close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					`timed out waiting for the account state lock. Delete ${lockPath} if no other pi process is adding or removing an account.`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true });
	}
}

/**
 * `commit` is the runtime half of the update. When it throws, the file goes back to what
 * it was, so persistent and runtime state are always both changed or both unchanged.
 */
export async function mutateAccounts(
	agentDir: string,
	snapshot: readonly Account[],
	change: (accounts: Account[]) => Account[],
	commit?: (accounts: Account[]) => void,
): Promise<Account[]> {
	return withLock(agentDir, async () => {
		const current = await loadAccounts(agentDir);
		if (serializeState(current) !== serializeState(snapshot)) throw new Error(STALE_SNAPSHOT_MESSAGE);
		const next = sortForPersistence(change(current));
		await writeState(agentDir, next);
		try {
			commit?.(next);
		} catch (error) {
			await writeState(agentDir, current);
			throw error;
		}
		return next;
	});
}
