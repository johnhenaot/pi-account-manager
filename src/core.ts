export const PROVIDERS = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export interface Account {
  provider: ProviderId;
  name: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** trim + ASCII A-Z lowercase only (spec §2). Not .toLowerCase(): U+212A etc. must stay put so validation rejects them. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isProviderId(x: string): x is ProviderId {
  return  Object.hasOwn(PROVIDERS, x);
}

export const aliasId = (a: Account): string => `${a.provider}@${a.name}`;
export const aliasDisplayName = (a: Account): string => `${PROVIDERS[a.provider]} (${a.name})`;

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function sortAccounts(list: readonly Account[]): Account[] {
  return [...list].sort(
    (a, b) => cmp(PROVIDERS[a.provider], PROVIDERS[b.provider]) || cmp(a.name, b.name),
  );
}

export function sameAccounts(a: readonly Account[], b: readonly Account[]): boolean {
  const key = (l: readonly Account[]) => sortAccounts(l).map(aliasId).join("\n");
  return key(a) === key(b);
}

/** Strict accounts.json parser (spec §6). Any deviation throws — no partial recovery. */
export function parseState(json: string): Account[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("invalid JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("top-level value must be an object");
  }
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).sort().join(",") !== "accounts,version") {
    throw new Error("top-level object must contain exactly version and accounts");
  }
  if (obj.version !== 1) throw new Error(`unsupported version: ${JSON.stringify(obj.version)}`);
  if (!Array.isArray(obj.accounts)) throw new Error("accounts must be an array");
  const accounts: Account[] = [];
  const seen = new Set<string>();
  for (const entry of obj.accounts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each account must be an object");
    }
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "name,provider") {
      throw new Error("each account must contain exactly provider and name");
    }
    if (typeof e.provider !== "string" || !isProviderId(e.provider)) {
      throw new Error(`unsupported provider: ${JSON.stringify(e.provider)}`);
    }
    if (typeof e.name !== "string" || !isValidName(e.name)) {
      throw new Error(`invalid account name: ${JSON.stringify(e.name)}`);
    }
    const account: Account = { provider: e.provider, name: e.name };
    const id = aliasId(account);
    if (seen.has(id)) throw new Error(`duplicate account: ${id}`);
    seen.add(id);
    accounts.push(account);
  }
  return sortAccounts(accounts);
}

export function serializeState(accounts: readonly Account[]): string {
  return `${JSON.stringify(
    { version: 1, accounts: sortAccounts(accounts).map(({ provider, name }) => ({ provider, name })) },
    null,
    2,
  )}\n`;
}

export type AccountCommand =
  | { kind: "list" }
  | { kind: "add"; name?: string }
  | { kind: "remove"; target?: string }
  | { kind: "usage" };

export function parseAccountArgs(args: string): AccountCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 2) return { kind: "usage" };
  const [sub, arg] = parts;
  if (sub === undefined) return { kind: "list" };
  if (sub === "list") return arg === undefined ? { kind: "list" } : { kind: "usage" };
  if (sub === "add") return { kind: "add", name: arg };
  if (sub === "remove") return { kind: "remove", target: arg };
  return { kind: "usage" };
}

export type RemoveResolution =
  | { kind: "account"; account: Account }
  | { kind: "choose"; matches: Account[] }
  | { kind: "none" };

/** Spec §3.3 target resolution: exact alias id, else normalized-name match. */
export function resolveRemoveTarget(target: string, accounts: readonly Account[]): RemoveResolution {
  const exact = accounts.find((a) => aliasId(a) === target);
  if (exact) return { kind: "account", account: exact };
  const name = normalizeName(target);
  if (!isValidName(name)) return { kind: "none" };
  const matches = sortAccounts(accounts.filter((a) => a.name === name));
  if (matches.length === 1) return { kind: "account", account: matches[0] };
  if (matches.length >= 2) return { kind: "choose", matches };
  return { kind: "none" };
}
