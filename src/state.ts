import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Account,
	aliasId,
	errorMessage,
	isProviderId,
	isValidName,
	normalizeName,
	sortForPersistence,
} from "./account.ts";

const stateDir = (agentDir: string): string => join(agentDir, "pi-account-manager");
export const statePath = (agentDir: string): string => join(stateDir(agentDir), "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
	Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function parseState(text: string): Account[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("accounts.json is not valid JSON.");
	}
	if (!isRecord(raw)) throw new Error("accounts.json must contain a JSON object.");
	if (!hasExactKeys(raw, ["version", "accounts"]))
		throw new Error('accounts.json must contain exactly "version" and "accounts".');
	if (raw.version !== 1) throw new Error(`accounts.json has unsupported version ${JSON.stringify(raw.version)}.`);
	if (!Array.isArray(raw.accounts)) throw new Error('accounts.json "accounts" must be an array.');

	const seen = new Set<string>();
	const accounts: Account[] = [];
	for (const entry of raw.accounts) {
		if (!isRecord(entry)) throw new Error("accounts.json has an account entry that is not an object.");
		if (!hasExactKeys(entry, ["provider", "name"]))
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
		throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
	}
	return parseState(text);
}

/** Writes the next state beside the real file without publishing it yet. */
async function stageState(agentDir: string, accounts: readonly Account[]): Promise<string> {
	const temp = `${statePath(agentDir)}.${process.pid}.tmp`;
	await writeFile(temp, serializeState(accounts), "utf8");
	return temp;
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
 * `commit` is the runtime half of the update; it returns its own inverse, which runs if
 * publishing the file then fails. Persistent and runtime state therefore end up both
 * changed or both unchanged.
 */
export async function mutateAccounts(
	agentDir: string,
	snapshot: readonly Account[],
	change: (accounts: Account[]) => Account[],
	commit?: (accounts: Account[]) => (() => void) | void,
): Promise<Account[]> {
	return withLock(agentDir, async () => {
		let current: Account[];
		try {
			current = await loadAccounts(agentDir);
		} catch (error) {
			// A file that no longer parses differs from our snapshot just as much as a
			// duplicate appearing does, and /reload is the recovery for both.
			throw new Error(`${STALE_SNAPSHOT_MESSAGE} (${errorMessage(error)})`);
		}
		if (serializeState(current) !== serializeState(snapshot)) throw new Error(STALE_SNAPSHOT_MESSAGE);

		// Staged, then committed, then published: another process must never load a state
		// that this one is about to abandon, so the rename happens last.
		const next = sortForPersistence(change(current));
		const staged = await stageState(agentDir, next);

		let undoCommit: (() => void) | void;
		try {
			undoCommit = commit?.(next);
		} catch (error) {
			await rm(staged, { force: true });
			throw error;
		}

		try {
			await rename(staged, statePath(agentDir));
		} catch (error) {
			// Publishing failed after the runtime half succeeded, so put the runtime back
			// rather than leaving it ahead of the file.
			try {
				undoCommit?.();
			} catch {
				// The original failure is the useful one to report.
			}
			await rm(staged, { force: true });
			throw error;
		}
		return next;
	});
}
