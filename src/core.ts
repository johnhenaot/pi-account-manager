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
