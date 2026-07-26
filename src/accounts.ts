/**
 * Account identity, `/account` parsing, and the persistent account file.
 *
 * Everything here is pi-independent so it can be tested without a session.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROVIDERS = {
	anthropic: "Anthropic",
	"openai-codex": "OpenAI Codex",
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export interface Account {
	provider: ProviderId;
	name: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const NAME_RULE = 'Use 1-32 characters from a-z, 0-9, "_" and "-", starting with a letter or digit.';

/** `String.prototype.trim()` then ASCII-only A-Z lowercasing, per the design. */
export const normalizeName = (raw: string): string => raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

export const isProviderId = (value: string): value is ProviderId => Object.hasOwn(PROVIDERS, value);

export const aliasId = (provider: ProviderId, name: string): string => `${provider}@${name}`;

export const aliasDisplayName = (provider: ProviderId, name: string): string => `${PROVIDERS[provider]} (${name})`;

export const accountId = (account: Account): string => aliasId(account.provider, account.name);

export const providerIdFor = (displayName: string): ProviderId | undefined =>
	(Object.keys(PROVIDERS) as ProviderId[]).find((id) => PROVIDERS[id] === displayName);

/** Code-unit compare: names are `[a-z0-9_-]`, so this is stable everywhere. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Persistence order: provider ID, then name. */
export const canonical = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort((a, b) => cmp(a.provider, b.provider) || cmp(a.name, b.name));

/** Listing order: provider display name, then name. */
export const sortForDisplay = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort((a, b) => cmp(PROVIDERS[a.provider], PROVIDERS[b.provider]) || cmp(a.name, b.name));

// =============================================================================
// State file
// =============================================================================

export const stateDir = (agentDir: string): string => join(agentDir, "pi-account-manager");
export const statePath = (agentDir: string): string => join(stateDir(agentDir), "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
};

/** Strict version 1 parse. Anything unexpected is an error, never a partial recovery. */
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
	return canonical(accounts);
}

export const serializeState = (accounts: readonly Account[]): string =>
	`${JSON.stringify({ version: 1, accounts: canonical(accounts) }, null, 2)}\n`;

/** A missing file is an empty account set; anything else unreadable is an error. */
export async function loadAccounts(agentDir: string): Promise<Account[]> {
	const path = statePath(agentDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
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
/** Well beyond LOCK_TIMEOUT_MS, so only a lock abandoned by a dead writer is broken. */
export const STALE_LOCK_MS = 60_000;
export const STALE_SNAPSHOT_MESSAGE = "named accounts changed in another process. Run /reload, then try again.";

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
			// ponytail: abandonment by mtime age, not holder liveness. A writer paused
			// longer than STALE_LOCK_MS can be stolen from; use proper-lockfile if that matters.
			const held = await stat(lockPath).catch(() => undefined);
			if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
				await rm(lockPath, { force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new Error("timed out waiting for the account state lock.");
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
 * Reread authoritative state under a lock, refuse to proceed if it drifted from
 * `snapshot`, apply `change`, then run `commit` (the runtime half of the update).
 * A throwing `commit` restores the previous file, so persistent and runtime state
 * are always both changed or both unchanged.
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
		const next = canonical(change(current));
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

// =============================================================================
// Command parsing
// =============================================================================

export type Command =
	| { kind: "list" }
	| { kind: "add"; name?: string }
	| { kind: "remove"; target?: string }
	| { kind: "usage" };

export const USAGE = [
	"Usage:",
	"  /account                        list named accounts",
	"  /account list                   list named accounts",
	"  /account add [name]             add a named account",
	"  /account remove [name|alias-id] remove a named account",
].join("\n");

export function parseCommand(args: string): Command {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };
	if (tokens.length > 2) return { kind: "usage" };
	const [head, argument] = tokens;
	if (head === "list") return argument === undefined ? { kind: "list" } : { kind: "usage" };
	if (head === "add") return { kind: "add", name: argument };
	if (head === "remove") return { kind: "remove", target: argument };
	return { kind: "usage" };
}

export type RemoveTarget =
	| { kind: "one"; account: Account }
	| { kind: "choose"; accounts: Account[] }
	| { kind: "none" };

export function resolveRemoveTarget(accounts: readonly Account[], argument: string | undefined): RemoveTarget {
	const loaded = sortForDisplay(accounts);
	if (argument === undefined) return loaded.length === 0 ? { kind: "none" } : { kind: "choose", accounts: loaded };

	const exact = loaded.find((account) => accountId(account) === argument);
	if (exact) return { kind: "one", account: exact };

	const name = normalizeName(argument);
	if (!isValidName(name)) return { kind: "none" };
	const matches = loaded.filter((account) => account.name === name);
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return { kind: "one", account: matches[0] };
	return { kind: "choose", accounts: matches };
}

// =============================================================================
// Listing
// =============================================================================

export const EMPTY_LIST = "No named accounts. Use /account add NAME.";

export function formatList(accounts: readonly Account[], status: (account: Account) => string): string {
	if (accounts.length === 0) return EMPTY_LIST;
	const rows = [
		["NAME", "PROVIDER", "ALIAS ID", "STATUS"],
		...sortForDisplay(accounts).map((account) => [
			account.name,
			PROVIDERS[account.provider],
			accountId(account),
			status(account),
		]),
	];
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	return rows
		.map((row) =>
			row
				.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}
