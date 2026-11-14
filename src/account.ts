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

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const NAME_RULE = 'Use 1-32 characters from a-z, 0-9, "_" and "-", starting with a letter or digit.';

// ASCII-only: `.toLowerCase()` would fold non-ASCII such as "İ" and change identity.
export const normalizeName = (raw: string): string => raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

export const isValidName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);

export const isProviderId = (value: string): value is ProviderId => Object.hasOwn(PROVIDERS, value);

export const accountId = (account: Account): string => `${account.provider}@${account.name}`;

// Not `localeCompare`: ICU collation varies by platform, making the saved order vary too.
// Provider IDs sort the same as their labels, so this one order serves display as well.
const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
export const sortAccounts = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort((a, b) => compare(a.provider, b.provider) || compare(a.name, b.name));
