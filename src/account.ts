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

const lowercaseAsciiOnly = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const normalizeName = (raw: string): string => lowercaseAsciiOnly(raw.trim());

export const isValidName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);

export const isProviderId = (value: string): value is ProviderId => Object.hasOwn(PROVIDERS, value);

export const accountId = (account: Account): string => `${account.provider}@${account.name}`;

const compareCodeUnits = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

export const sortAccounts = (accounts: readonly Account[]): Account[] =>
	[...accounts].sort((a, b) => compareCodeUnits(a.provider, b.provider) || compareCodeUnits(a.name, b.name));
