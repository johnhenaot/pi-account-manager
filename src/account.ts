export const PROVIDERS = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI Codex",
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export interface Account {
	provider: ProviderId;
	name: string;
}

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const NAME_RULE = 'Use 1-32 characters from a-z, 0-9, "_" and "-", starting with a letter or digit.';

// ASCII-only: `.toLowerCase()` would fold non-ASCII such as "İ" and change identity.
export const normalizeName = (raw: string): string => raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

export const isProviderId = (value: string): value is ProviderId => Object.hasOwn(PROVIDERS, value);

export const aliasId = (provider: ProviderId, name: string): string => `${provider}@${name}`;

export const aliasDisplayName = (provider: ProviderId, name: string): string => `${PROVIDERS[provider]} (${name})`;

export const accountId = (account: Account): string => aliasId(account.provider, account.name);

export const providerIdFor = (displayName: string): ProviderId | undefined =>
	(Object.keys(PROVIDERS) as ProviderId[]).find((id) => PROVIDERS[id] === displayName);

// Not `localeCompare`: ICU collation varies by platform, making the persisted order vary too.
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sortForPersistence = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort(
		(a, b) => compareCodeUnits(a.provider, b.provider) || compareCodeUnits(a.name, b.name),
	);

export const sortForDisplay = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort(
		(a, b) => compareCodeUnits(PROVIDERS[a.provider], PROVIDERS[b.provider]) || compareCodeUnits(a.name, b.name),
	);
