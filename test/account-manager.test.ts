import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, CredentialInfo, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Account,
	accountId,
	aliasDisplayName,
	aliasId,
	canonical,
	EMPTY_LIST,
	formatList,
	isValidName,
	loadAccounts,
	mutateAccounts,
	normalizeName,
	parseCommand,
	parseState,
	resolveRemoveTarget,
	serializeState,
	STALE_SNAPSHOT_MESSAGE,
	statePath,
	USAGE,
} from "../src/accounts.ts";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import createAccountManager, { ANTHROPIC_EXTRA_USAGE_WARNING, authState } from "../src/index.ts";

// =============================================================================
// Fixtures
// =============================================================================

let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-account-manager-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(agentDir, { recursive: true, force: true });
});

const writeStateFile = async (body: unknown) => {
	await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
	await writeFile(statePath(agentDir), typeof body === "string" ? body : JSON.stringify(body), "utf8");
};

const readStateFile = () => readFile(statePath(agentDir), "utf8");

const oauthCredential = (): Credential => ({
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 3_600_000,
});

function memoryCredentials(): CredentialStore & { entries: Map<string, Credential> } {
	const entries = new Map<string, Credential>();
	return {
		entries,
		async read(providerId) {
			return entries.get(providerId);
		},
		async list(): Promise<readonly CredentialInfo[]> {
			return [...entries].map(([providerId, credential]) => ({ providerId, type: credential.type }));
		},
		async modify(providerId, fn) {
			const next = await fn(entries.get(providerId));
			if (next) entries.set(providerId, next);
			return entries.get(providerId);
		},
		async delete(providerId) {
			entries.delete(providerId);
		},
	};
}

/** A real pi registry with no network, no models.json, and in-memory credentials. */
async function realRegistry() {
	const credentials = memoryCredentials();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	return { credentials, runtime, registry: new ModelRegistry(runtime) };
}

/** A minimal provider whose stream echoes the provider it was handed. */
function stubProvider(id: string, options: { oauth?: boolean; models?: number } = {}): Provider {
	const models = Array.from({ length: options.models ?? 2 }, (_, index) => ({
		id: `model-${index}`,
		name: `Model ${index}`,
		api: "anthropic-messages",
		provider: id,
		baseUrl: "https://stub.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	})) as Model<Api>[];
	const echo = (model: Model<Api>) => {
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		});
		stream.end();
		return stream;
	};
	return {
		id,
		name: id,
		baseUrl: "https://stub.example.com",
		auth: options.oauth === false ? { apiKey: { name: "key", async resolve() {
			return { auth: { apiKey: "k" } };
		} } } : {
			apiKey: { name: "key", async resolve() {
				return undefined;
			} },
			oauth: {
				name: "Stub OAuth",
				async login() {
					return oauthCredential() as never;
				},
				async refresh(credential) {
					return credential;
				},
				async toAuth() {
					return { apiKey: "oauth-token" };
				},
			},
		},
		getModels: () => models,
		stream: echo,
		streamSimple: echo,
	};
}

// =============================================================================
// Account identity
// =============================================================================

describe("names", () => {
	it("normalizes with trim then ASCII lowercasing only", () => {
		expect(normalizeName("  Work  ")).toBe("work");
		expect(normalizeName("WORK_1-a")).toBe("work_1-a");
		// Non-ASCII uppercase is left alone, so it fails validation rather than folding.
		expect(normalizeName("İstanbul")).toBe("İstanbul");
		expect(isValidName(normalizeName("İstanbul"))).toBe(false);
	});

	it("validates against the documented pattern", () => {
		for (const valid of ["a", "0", "work", "work-2", "my_account", "a".repeat(32)]) {
			expect(isValidName(valid), valid).toBe(true);
		}
		for (const invalid of ["", "-work", "_work", "Work", "work name", "work.dev", "a".repeat(33), "work@x"]) {
			expect(isValidName(invalid), invalid).toBe(false);
		}
	});

	it("derives alias IDs and display names", () => {
		expect(aliasId("anthropic", "work")).toBe("anthropic@work");
		expect(aliasId("openai-codex", "personal")).toBe("openai-codex@personal");
		expect(aliasDisplayName("anthropic", "work")).toBe("Anthropic (work)");
		expect(aliasDisplayName("openai-codex", "personal")).toBe("OpenAI Codex (personal)");
	});

	it("allows the same name once per provider", () => {
		const accounts: Account[] = [
			{ provider: "anthropic", name: "work" },
			{ provider: "openai-codex", name: "work" },
		];
		expect(new Set(accounts.map(accountId)).size).toBe(2);
	});
});

// =============================================================================
// State schema
// =============================================================================

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
		await writeStateFile("{ nope");
		await expect(loadAccounts(agentDir)).rejects.toThrow("not valid JSON");
	});
});

// =============================================================================
// Persistence lifecycle
// =============================================================================

describe("mutateAccounts", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	it("adds atomically and reports the new canonical set", async () => {
		const next = await mutateAccounts(agentDir, [], (accounts) => [...accounts, work]);
		expect(next).toEqual([work]);
		expect(JSON.parse(await readStateFile())).toEqual({ version: 1, accounts: [work] });
	});

	it("removes atomically", async () => {
		await writeStateFile({ version: 1, accounts: [work] });
		const next = await mutateAccounts(agentDir, [work], (accounts) =>
			accounts.filter((a) => accountId(a) !== "anthropic@work"),
		);
		expect(next).toEqual([]);
		expect(JSON.parse(await readStateFile())).toEqual({ version: 1, accounts: [] });
	});

	it("rolls the file back when the runtime half of the update fails", async () => {
		await writeStateFile({ version: 1, accounts: [] });
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
		expect(JSON.parse(await readStateFile())).toEqual({ version: 1, accounts: [] });
	});

	it("aborts with a /reload instruction when a record appeared behind our back", async () => {
		await writeStateFile({ version: 1, accounts: [work] });
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow(STALE_SNAPSHOT_MESSAGE);
	});

	it("aborts when the removal target disappeared behind our back", async () => {
		await writeStateFile({ version: 1, accounts: [] });
		await expect(
			mutateAccounts(agentDir, [work], (accounts) => accounts.filter(() => false)),
		).rejects.toThrow(STALE_SNAPSHOT_MESSAGE);
	});

	it("serializes concurrent writers without losing an update", async () => {
		const names = ["one", "two", "three", "four", "five"];
		// Each writer rereads under the lock, so all but one see a stale snapshot and abort.
		const results = await Promise.allSettled(
			names.map((name) =>
				mutateAccounts(agentDir, [], (accounts) => [...accounts, { provider: "anthropic", name }]),
			),
		);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		for (const rejected of results.filter((r) => r.status === "rejected")) {
			expect((rejected as PromiseRejectedResult).reason.message).toContain(STALE_SNAPSHOT_MESSAGE);
		}
		// Never a partial or duplicated persistent state.
		const persisted = parseState(await readStateFile());
		expect(persisted).toEqual(canonical(persisted));
		expect(new Set(persisted.map(accountId)).size).toBe(persisted.length);
	});

	it("fails from lock contention within five seconds rather than hanging", async () => {
		await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
		await writeFile(join(agentDir, "pi-account-manager", "accounts.lock"), "", "utf8");
		const started = Date.now();
		await expect(mutateAccounts(agentDir, [], (accounts) => accounts)).rejects.toThrow("lock");
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(4_000);
		expect(elapsed).toBeLessThan(9_000);
	}, 20_000);
});

// =============================================================================
// Command parsing and target resolution
// =============================================================================

describe("parseCommand", () => {
	it("accepts every documented form", () => {
		expect(parseCommand("")).toEqual({ kind: "list" });
		expect(parseCommand("   ")).toEqual({ kind: "list" });
		expect(parseCommand("list")).toEqual({ kind: "list" });
		expect(parseCommand("add")).toEqual({ kind: "add", name: undefined });
		expect(parseCommand("add work")).toEqual({ kind: "add", name: "work" });
		expect(parseCommand("remove")).toEqual({ kind: "remove", target: undefined });
		expect(parseCommand("remove anthropic@work")).toEqual({ kind: "remove", target: "anthropic@work" });
	});

	it("shows usage for unknown subcommands and excess arguments", () => {
		for (const args of ["status", "ADD work", "list extra", "add a b", "remove a b", "add work extra"]) {
			expect(parseCommand(args), args).toEqual({ kind: "usage" });
		}
		expect(USAGE).toContain("/account add [name]");
	});
});

describe("resolveRemoveTarget", () => {
	const anthropicWork: Account = { provider: "anthropic", name: "work" };
	const codexWork: Account = { provider: "openai-codex", name: "work" };
	const codexPersonal: Account = { provider: "openai-codex", name: "personal" };
	const all = [codexPersonal, codexWork, anthropicWork];

	it("offers every loaded account when no argument is given", () => {
		expect(resolveRemoveTarget(all, undefined)).toEqual({
			kind: "choose",
			accounts: [anthropicWork, codexPersonal, codexWork],
		});
		expect(resolveRemoveTarget([], undefined)).toEqual({ kind: "none" });
	});

	it("prefers an exact case-sensitive alias ID", () => {
		expect(resolveRemoveTarget(all, "openai-codex@work")).toEqual({ kind: "one", account: codexWork });
		// Wrong case is not an alias ID, and is not a valid name either.
		expect(resolveRemoveTarget(all, "OpenAI-Codex@work")).toEqual({ kind: "none" });
	});

	it("falls back to a normalized name match", () => {
		expect(resolveRemoveTarget(all, " PERSONAL ")).toEqual({ kind: "one", account: codexPersonal });
		expect(resolveRemoveTarget(all, "work")).toEqual({ kind: "choose", accounts: [anthropicWork, codexWork] });
	});

	it("resolves nothing for invalid input or a miss", () => {
		expect(resolveRemoveTarget(all, "not a name")).toEqual({ kind: "none" });
		expect(resolveRemoveTarget(all, "missing")).toEqual({ kind: "none" });
	});
});

describe("formatList", () => {
	it("orders by provider display name then account name", () => {
		const rows = formatList(
			[
				{ provider: "openai-codex", name: "work" },
				{ provider: "anthropic", name: "work" },
				{ provider: "anthropic", name: "alt" },
			],
			() => "authenticated",
		).split("\n");
		expect(rows[0]).toMatch(/^NAME\s+PROVIDER\s+ALIAS ID\s+STATUS$/);
		expect(rows.slice(1).map((row) => row.split(/\s{2,}/)[2])).toEqual([
			"anthropic@alt",
			"anthropic@work",
			"openai-codex@work",
		]);
	});

	it("shows every status verbatim", () => {
		const statuses = ["authenticated", "not authenticated", "status unavailable"];
		const text = formatList(
			statuses.map((_, index) => ({ provider: "anthropic" as const, name: `a${index}` })),
			(account) => statuses[Number(account.name.slice(1))],
		);
		for (const status of statuses) expect(text).toContain(status);
	});

	it("has an exact empty message", () => {
		expect(formatList([], () => "authenticated")).toBe("No named accounts. Use /account add NAME.");
		expect(EMPTY_LIST).toBe("No named accounts. Use /account add NAME.");
	});
});

// =============================================================================
// Alias construction
// =============================================================================

describe("buildAlias", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	it("builds from pi's exact bundled factory", () => {
		const base = bundledProvider("anthropic");
		expect(base?.id).toBe("anthropic");
		const alias = buildAlias(base, work);
		expect(alias.id).toBe("anthropic@work");
		expect(alias.name).toBe("Anthropic (work)");
		expect(alias.baseUrl).toBe(base?.baseUrl);
	});

	it("builds from both supported bundled providers", () => {
		for (const provider of ["anthropic", "openai-codex"] as const) {
			const alias = buildAlias(bundledProvider(provider), { provider, name: "personal" });
			expect(alias.id).toBe(`${provider}@personal`);
			expect(alias.getModels().length).toBeGreaterThan(0);
		}
	});

	it("exposes OAuth only, never an API key or ambient credential", () => {
		const base = bundledProvider("anthropic")!;
		const alias = buildAlias(base, work);
		expect(alias.auth.oauth).toBe(base.auth.oauth);
		expect(alias.auth.apiKey).toBeUndefined();
		// The native provider does offer an API key path; the alias deliberately drops it.
		expect(base.auth.apiKey).toBeDefined();
	});

	it("mirrors the native catalog with the alias ID as provider", () => {
		const base = bundledProvider("anthropic")!;
		const native = base.getModels();
		const aliased = buildAlias(base, work).getModels();
		expect(aliased.map((m) => m.id)).toEqual(native.map((m) => m.id));
		expect(new Set(aliased.map((m) => m.provider))).toEqual(new Set(["anthropic@work"]));
		for (const [index, model] of aliased.entries()) {
			expect({ ...model, provider: "anthropic" }).toEqual(native[index]);
		}
	});

	it("tracks a native catalog change without being rebuilt", () => {
		let models = stubProvider("anthropic").getModels();
		const base: Provider = { ...stubProvider("anthropic"), getModels: () => models };
		const alias = buildAlias(base, work);
		expect(alias.getModels()).toHaveLength(2);
		models = models.slice(0, 1);
		expect(alias.getModels()).toHaveLength(1);
	});

	it("attributes the stream to the alias and delegates to the native provider", async () => {
		const alias = buildAlias(stubProvider("anthropic"), work);
		const model = alias.getModels()[0];
		const message = await alias.streamSimple(model, { messages: [] }).result();
		expect(message.provider).toBe("anthropic@work");
		expect(message.model).toBe(model.id);
	});

	it("preserves a native model filter across the provider remap", () => {
		const base: Provider = {
			...stubProvider("anthropic"),
			filterModels: (models) => models.filter((model) => model.id === "model-1" && model.provider === "anthropic"),
		};
		const alias = buildAlias(base, work);
		const kept = alias.filterModels!(alias.getModels(), undefined);
		expect(kept.map((model) => model.id)).toEqual(["model-1"]);
		expect(kept.map((model) => model.provider)).toEqual(["anthropic@work"]);
	});

	it("refuses a base that cannot back an alias", () => {
		expect(() => buildAlias(undefined, work)).toThrow("not available");
		expect(() => buildAlias(stubProvider("anthropic", { oauth: false }), work)).toThrow("no OAuth flow");
		expect(() => buildAlias(stubProvider("anthropic", { models: 0 }), work)).toThrow("no models");
		expect(() => buildAlias(stubProvider("openai"), work)).toThrow('resolved to "openai"');
	});
});

// =============================================================================
// Contract: pi 0.82's real provider registry
// =============================================================================

describe("pi registry contract", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	it("registers an alias alongside the native provider it wraps", async () => {
		const { registry } = await realRegistry();
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		expect(registry.getProvider("anthropic@work")?.name).toBe("Anthropic (work)");
		expect(registry.getProvider("anthropic")?.id).toBe("anthropic");
		expect(registry.getRegisteredProviderIds()).toContain("anthropic@work");
	});

	it("mirrors the effective provider's models under the alias ID", async () => {
		const { registry } = await realRegistry();
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		const native = registry.getAll().filter((model) => model.provider === "anthropic");
		const aliased = registry.getAll().filter((model) => model.provider === "anthropic@work");
		expect(aliased.map((m) => m.id)).toEqual(native.map((m) => m.id));
		expect(aliased.map((m) => [m.name, m.contextWindow, m.maxTokens, m.cost])).toEqual(
			native.map((m) => [m.name, m.contextWindow, m.maxTokens, m.cost]),
		);
	});

	it("gates alias model availability on an alias-scoped OAuth credential", async () => {
		const { credentials, runtime, registry } = await realRegistry();
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(false);
		expect((await runtime.getAvailable()).some((m) => m.provider === "anthropic@work")).toBe(false);
		expect(authState(registry, "anthropic@work")).toBe("not authenticated");

		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);
		expect(runtime.isUsingOAuth("anthropic@work")).toBe(true);
		expect((await runtime.getAvailable()).some((m) => m.provider === "anthropic@work")).toBe(true);
		expect(authState(registry, "anthropic@work")).toBe("authenticated");
	});

	it("keeps credentials isolated per alias", async () => {
		const { credentials, runtime, registry } = await realRegistry();
		for (const name of ["work", "personal"]) {
			registry.registerProvider(buildAlias(registry.getProvider("anthropic"), { provider: "anthropic", name }));
		}
		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);
		expect(runtime.getProviderAuthStatus("anthropic@personal").configured).toBe(false);
		expect(credentials.entries.has("anthropic")).toBe(false);
	});

	it("leaves the account registered but unauthenticated after logout", async () => {
		const { credentials, runtime, registry } = await realRegistry();
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);

		await runtime.logout("anthropic@work");
		expect(runtime.getProvider("anthropic@work")).toBeDefined();
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(false);
		expect(runtime.getModels().some((m) => m.provider === "anthropic@work")).toBe(true);
	});

	it("participates in /login as an OAuth-only provider", async () => {
		const { registry, runtime } = await realRegistry();
		const native = registry.getProvider("anthropic")!;
		registry.registerProvider(buildAlias(native, work));
		await runtime.refresh({ allowNetwork: false });

		const alias = runtime.getProvider("anthropic@work")!;
		// pi's /login offers one option per auth method a provider exposes.
		expect(alias.auth.apiKey).toBeUndefined();
		// The native OAuth flow is reused, so /login runs pi's own Anthropic flow.
		expect(alias.auth.oauth).toBe(native.auth.oauth);
		expect(alias.auth.oauth?.name).toBe("Anthropic (Claude Pro/Max)");
	});

	it("unregisters cleanly, leaving the native provider usable", async () => {
		const { runtime, registry } = await realRegistry();
		const nativeModelCount = registry.getAll().filter((m) => m.provider === "anthropic").length;
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		registry.unregisterProvider("anthropic@work");
		expect(runtime.getProvider("anthropic@work")).toBeUndefined();
		expect(authState(registry, "anthropic@work")).toBe("status unavailable");
		expect(registry.getAll().filter((m) => m.provider === "anthropic")).toHaveLength(nativeModelCount);
	});
});

// =============================================================================
// Extension behavior
// =============================================================================

interface Notification {
	message: string;
	type: string;
}

/** Drives the real extension factory against a real registry and a scripted UI. */
async function harness(
	options: {
		editorText?: string;
		answers?: (string | undefined)[];
		model?: Model<Api>;
		/** Make pi reject this provider ID, to exercise registration rollback. */
		rejectProviderId?: string;
	} = {},
) {
	const { credentials, runtime, registry } = await realRegistry();
	const notifications: Notification[] = [];
	const answers = [...(options.answers ?? [])];
	let editorText = options.editorText ?? "";

	const ui = {
		notify: (message: string, type = "info") => notifications.push({ message, type }),
		input: async () => answers.shift(),
		select: async () => answers.shift(),
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
	};

	// A gate in front of the real registry, so a registration can be made to fail
	// on either the bootstrap path (pi) or the session_start path (ctx.modelRegistry).
	let rejectProviderId = options.rejectProviderId;
	const guardedRegistry = new Proxy(registry, {
		get(target, property) {
			if (property === "registerProvider") {
				return (provider: Provider | string, config?: unknown) => {
					if (typeof provider !== "string" && provider.id === rejectProviderId) {
						throw new Error(`rejected ${provider.id}`);
					}
					(registry.registerProvider as (a: unknown, b?: unknown) => void)(provider, config);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	const ctx = {
		ui,
		mode: "tui" as string,
		cwd: agentDir,
		modelRegistry: guardedRegistry,
		model: options.model,
		isProjectTrusted: () => true,
	};

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const providers = new Map<string, Provider>();

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: (_name: string, options_: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = options_.handler;
		},
		registerProvider: (provider: Provider) => {
			guardedRegistry.registerProvider(provider);
			providers.set(provider.id, provider);
		},
		unregisterProvider: (id: string) => {
			providers.delete(id);
			registry.unregisterProvider(id);
		},
	};

	await createAccountManager(pi as never);

	return {
		credentials,
		runtime,
		registry,
		notifications,
		providers,
		last: () => notifications[notifications.length - 1],
		editor: () => editorText,
		account: (args: string) => command!(args, ctx),
		emit: (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx),
		setMode: (mode: string) => {
			ctx.mode = mode;
		},
		setModel: (model: Model<Api> | undefined) => {
			ctx.model = model;
		},
		rejectProvider: (id: string | undefined) => {
			rejectProviderId = id;
		},
	};
}

describe("/account list", () => {
	it("reports an empty snapshot with the exact message", async () => {
		const pi = await harness();
		await pi.account("");
		expect(pi.last()).toEqual({ message: EMPTY_LIST, type: "info" });
	});

	it("lists loaded accounts with name, provider, alias ID, and status", async () => {
		await writeStateFile({
			version: 1,
			accounts: [
				{ provider: "anthropic", name: "work" },
				{ provider: "openai-codex", name: "personal" },
			],
		});
		const pi = await harness();
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });

		await pi.account("list");
		const text = pi.last().message;
		expect(text).toContain("anthropic@work");
		expect(text).toContain("Anthropic");
		expect(text).toContain("authenticated");
		expect(text).toContain("openai-codex@personal");
		expect(text).toContain("not authenticated");
	});

	it("shows the load error instead of rows, and still refuses changes", async () => {
		await writeStateFile("{ broken");
		const pi = await harness();
		expect(pi.providers.size).toBe(0);

		await pi.account("");
		expect(pi.last().type).toBe("error");
		expect(pi.last().message).toContain("not valid JSON");

		await pi.account("add work");
		expect(pi.last().message).toContain("/reload");
		await pi.account("remove work");
		expect(pi.last().message).toContain("/reload");
	});

	it("changes nothing", async () => {
		await writeStateFile({ version: 1, accounts: [{ provider: "anthropic", name: "work" }] });
		const pi = await harness();
		const before = await readStateFile();
		await pi.account("list");
		expect(await readStateFile()).toBe(before);
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});

	it("uses the loaded snapshot instead of rereading persistent state", async () => {
		await writeStateFile({ version: 1, accounts: [{ provider: "anthropic", name: "work" }] });
		const pi = await harness();

		// Another process changes the file; this process keeps its snapshot until reload.
		await writeStateFile({ version: 1, accounts: [{ provider: "openai-codex", name: "elsewhere" }] });
		await pi.account("list");
		expect(pi.last().message).toContain("anthropic@work");
		expect(pi.last().message).not.toContain("elsewhere");
	});
});

describe("/account usage", () => {
	it("shows usage and makes no state change", async () => {
		const pi = await harness();
		await pi.account("bogus");
		expect(pi.last()).toEqual({ message: USAGE, type: "error" });
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});

	it("is interactive-only", async () => {
		const pi = await harness();
		for (const mode of ["rpc", "json", "print"]) {
			pi.setMode(mode);
			await pi.account("add work");
			expect(pi.last().message).toContain("interactive mode only");
		}
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});
});

describe("/account add", () => {
	it("prompts for name and provider, persists, registers, and prefills /login", async () => {
		const pi = await harness({ answers: ["  WORK ", "Anthropic"] });
		await pi.account("add");

		expect(await loadAccounts(agentDir)).toEqual([{ provider: "anthropic", name: "work" }]);
		expect(pi.registry.getProvider("anthropic@work")?.name).toBe("Anthropic (work)");
		expect(pi.editor()).toBe("/login anthropic@work");
	});

	it("preserves a non-empty editor and shows the exact command instead", async () => {
		const pi = await harness({ editorText: "draft text", answers: ["OpenAI Codex"] });
		await pi.account("add personal");
		expect(pi.editor()).toBe("draft text");
		expect(pi.last().message).toContain("/login openai-codex@personal");
	});

	it("makes no state change when the name prompt is cancelled", async () => {
		const pi = await harness({ answers: [undefined] });
		await pi.account("add");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.providers.size).toBe(0);
	});

	it("makes no state change when the provider prompt is cancelled", async () => {
		const pi = await harness({ answers: [undefined] });
		await pi.account("add work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.providers.size).toBe(0);
	});

	it("rejects an invalid name before prompting for a provider", async () => {
		const pi = await harness({ answers: ["Anthropic"] });
		await pi.account("add bad name");
		expect(pi.last()).toEqual({ message: USAGE, type: "error" });

		const pi2 = await harness({ answers: ["-nope", "Anthropic"] });
		await pi2.account("add");
		expect(pi2.last().type).toBe("error");
		expect(pi2.last().message).toContain("Invalid account name");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("rejects an existing (provider, name) and points at /login", async () => {
		await writeStateFile({ version: 1, accounts: [{ provider: "anthropic", name: "work" }] });
		const pi = await harness({ answers: ["Anthropic"] });
		await pi.account("add work");
		expect(pi.last().type).toBe("error");
		expect(pi.last().message).toBe("anthropic@work already exists. Use /login anthropic@work to reauthenticate it.");
	});

	it("allows the same name under the other provider", async () => {
		await writeStateFile({ version: 1, accounts: [{ provider: "anthropic", name: "work" }] });
		const pi = await harness({ answers: ["OpenAI Codex"] });
		await pi.account("add work");
		expect((await loadAccounts(agentDir)).map(accountId)).toEqual(["anthropic@work", "openai-codex@work"]);
	});

	it("refuses when the alias ID is already owned by another provider", async () => {
		const pi = await harness({ answers: ["Anthropic"] });
		pi.registry.registerProvider(stubProvider("anthropic@taken"));
		await pi.account("add taken");
		expect(pi.last().message).toContain("already in use");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("aborts with a /reload instruction when state drifted", async () => {
		const pi = await harness({ answers: ["Anthropic"] });
		await writeStateFile({ version: 1, accounts: [{ provider: "openai-codex", name: "other" }] });
		await pi.account("add work");
		expect(pi.last().message).toContain("/reload");
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
	});
});

describe("/account remove", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	const seeded = async (accounts: Account[], options: Parameters<typeof harness>[0] = {}) => {
		await writeStateFile({ version: 1, accounts });
		const pi = await harness(options);
		pi.emit("session_start", { type: "session_start", reason: "startup" });
		await pi.runtime.refresh({ allowNetwork: false });
		return pi;
	};

	it("removes an unauthenticated, inactive account and unregisters it", async () => {
		const pi = await seeded([work]);
		await pi.account("remove anthropic@work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(pi.last().type).toBe("info");
	});

	it("resolves a bare name to its single match", async () => {
		const pi = await seeded([work]);
		await pi.account("remove WORK");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("offers a selector for two name matches", async () => {
		const pi = await seeded([work, { provider: "openai-codex", name: "work" }], {
			answers: ["openai-codex@work"],
		});
		await pi.account("remove work");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("offers a selector when no argument is given", async () => {
		const pi = await seeded([work], { answers: ["anthropic@work"] });
		await pi.account("remove");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("makes no state change when the selector is cancelled", async () => {
		const pi = await seeded([work], { answers: [undefined] });
		await pi.account("remove");
		expect(await loadAccounts(agentDir)).toEqual([work]);
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});

	it("makes no state change for invalid input or a miss", async () => {
		const pi = await seeded([work]);
		for (const argument of ["not a name", "missing", "Anthropic@work"]) {
			await pi.account(`remove ${argument}`);
			expect(pi.last().type, argument).toBe("error");
		}
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("refuses an authenticated account and instructs /logout", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/logout");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("refuses the active model's account and instructs /model", async () => {
		const pi = await seeded([work]);
		pi.setModel(pi.registry.getAll().find((model) => model.provider === "anthropic@work"));
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/model");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("shows both instructions when both apply", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });
		pi.setModel(pi.registry.getAll().find((model) => model.provider === "anthropic@work"));
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/logout");
		expect(pi.last().message).toContain("/model");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("fails closed when authentication status is unavailable", async () => {
		const pi = await seeded([work]);
		// Drop the alias out of the registry so pi can no longer report its status.
		pi.registry.unregisterProvider("anthropic@work");
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("status is unavailable");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("leaves the credential in place", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@other", async () => oauthCredential());
		await pi.account("remove anthropic@work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.credentials.entries.has("anthropic@other")).toBe(true);
	});

	it("aborts with a /reload instruction when the target disappeared", async () => {
		const pi = await seeded([work]);
		await writeStateFile({ version: 1, accounts: [] });
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/reload");
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});
});

describe("loading lifecycle", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	it("bootstraps every persisted account before any session starts", async () => {
		await writeStateFile({ version: 1, accounts: [work, { provider: "openai-codex", name: "personal" }] });
		const pi = await harness();
		expect([...pi.providers.keys()].sort()).toEqual(["anthropic@work", "openai-codex@personal"]);
	});

	it("replaces bootstrap aliases against the effective registry on session_start", async () => {
		await writeStateFile({ version: 1, accounts: [work] });
		const pi = await harness();
		const bootstrapped = pi.registry.getProvider("anthropic@work");
		pi.emit("session_start", { type: "session_start", reason: "startup" });
		const replaced = pi.registry.getProvider("anthropic@work");
		expect(replaced).toBeDefined();
		expect(replaced).not.toBe(bootstrapped);
		expect(replaced?.name).toBe("Anthropic (work)");
	});

	it("loads no alias at all when one bootstrap registration fails", async () => {
		const accounts = [work, { provider: "anthropic", name: "second" } as Account, {
			provider: "openai-codex",
			name: "third",
		} as Account];
		await writeStateFile({ version: 1, accounts });

		const ok = await harness();
		expect([...ok.providers.keys()]).toHaveLength(3);

		// The third registration fails, so the first two must be rolled back.
		const failed = await harness({ rejectProviderId: "openai-codex@third" });
		expect([...failed.providers.keys()]).toEqual([]);
		expect(failed.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(failed.registry.getProvider("anthropic@second")).toBeUndefined();
		// Native providers stay usable, and /account still reports the failure.
		expect(failed.registry.getProvider("anthropic")?.id).toBe("anthropic");
		await failed.account("");
		expect(failed.last().type).toBe("error");
		expect(failed.last().message).toContain("rejected openai-codex@third");
	});

	it("keeps no alias loaded when the session_start replacement fails", async () => {
		await writeStateFile({ version: 1, accounts: [work, { provider: "openai-codex", name: "personal" }] });
		const pi = await harness();
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();

		pi.rejectProvider("openai-codex@personal");
		pi.emit("session_start", { type: "session_start", reason: "reload" });

		// Neither the replacement nor the bootstrap alias may survive.
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(pi.registry.getProvider("openai-codex@personal")).toBeUndefined();
		expect(pi.registry.getProvider("anthropic")?.id).toBe("anthropic");

		await pi.account("");
		expect(pi.last().type).toBe("error");
		await pi.account("add other");
		expect(pi.last().message).toContain("/reload");
	});

	it("keeps native providers usable when loading fails", async () => {
		await writeStateFile("{ broken");
		const pi = await harness();
		expect(pi.providers.size).toBe(0);
		expect(pi.registry.getProvider("anthropic")?.id).toBe("anthropic");
		expect(pi.registry.getAll().some((model) => model.provider === "anthropic")).toBe(true);
	});

	it("recreates the same alias when the same pair is re-added", async () => {
		const pi = await harness({ answers: ["Anthropic"] });
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.account("add work");
		await pi.runtime.refresh({ allowNetwork: false });
		// An externally kept credential makes the re-added account immediately authenticated.
		expect(authState(pi.registry, "anthropic@work")).toBe("authenticated");
	});
});

describe("anthropic extra-usage warning", () => {
	const work: Account = { provider: "anthropic", name: "work" };

	const authenticated = async (settings?: unknown) => {
		if (settings !== undefined) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");
		await writeStateFile({ version: 1, accounts: [work, { provider: "openai-codex", name: "personal" }] });
		const pi = await harness();
		pi.emit("session_start", { type: "session_start", reason: "startup" });
		for (const id of ["anthropic@work", "openai-codex@personal"]) {
			await pi.credentials.modify(id, async () => oauthCredential());
		}
		await pi.runtime.refresh({ allowNetwork: false });
		return pi;
	};

	const select = (pi: Awaited<ReturnType<typeof harness>>, provider: string, source = "set") =>
		pi.emit("model_select", {
			type: "model_select",
			source,
			model: pi.registry.getAll().find((model) => model.provider === provider),
		});

	it("warns once per process with the exact text", async () => {
		const pi = await authenticated();
		select(pi, "anthropic@work");
		expect(pi.last()).toEqual({ message: ANTHROPIC_EXTRA_USAGE_WARNING, type: "warning" });
		const count = pi.notifications.length;
		select(pi, "anthropic@work", "restore");
		select(pi, "anthropic@work", "cycle");
		expect(pi.notifications).toHaveLength(count);
	});

	it("warns on restore too", async () => {
		const pi = await authenticated();
		select(pi, "anthropic@work", "restore");
		expect(pi.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);
	});

	it("stays quiet for other providers and for unauthenticated aliases", async () => {
		const pi = await authenticated();
		select(pi, "openai-codex@personal");
		select(pi, "anthropic");
		expect(pi.notifications).toHaveLength(0);

		await pi.runtime.logout("anthropic@work");
		select(pi, "anthropic@work");
		expect(pi.notifications).toHaveLength(0);
	});

	it("is suppressed only by an explicit false", async () => {
		const off = await authenticated({ warnings: { anthropicExtraUsage: false } });
		select(off, "anthropic@work");
		expect(off.notifications).toHaveLength(0);

		const on = await authenticated({ warnings: { anthropicExtraUsage: true } });
		select(on, "anthropic@work");
		expect(on.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);

		const unset = await authenticated({ warnings: {} });
		select(unset, "anthropic@work");
		expect(unset.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);
	});

	it("warns when the setting cannot be read, and never blocks model use", async () => {
		const pi = await authenticated("not json at all");
		expect(() => select(pi, "anthropic@work")).not.toThrow();
		expect(pi.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);
	});

	it("stays quiet outside interactive mode", async () => {
		const pi = await authenticated();
		pi.setMode("rpc");
		select(pi, "anthropic@work");
		expect(pi.notifications).toHaveLength(0);
	});
});
