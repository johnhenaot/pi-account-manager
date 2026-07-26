import type { Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Account,
	accountId,
	errorMessage,
	isValidName,
	NAME_RULE,
	normalizeName,
	PROVIDERS,
	type ProviderId,
	providerIdFor,
} from "./account.ts";
import { buildAlias, bundledProvider } from "./alias.ts";
import { parseCommand, resolveRemoveTarget, USAGE } from "./command.ts";
import { adoptNativeDefaultModel } from "./default-model.ts";
import { EMPTY_LIST, formatList } from "./list.ts";
import { loadAccounts, mutateAccounts } from "./state.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

/**
 * `/reload` re-runs the extension factory in the same process, so a factory-local latch
 * would let the once-per-process warning fire again. Keyed on globalThis so it survives
 * both a new factory closure and a re-evaluated module. Exported so tests can clear it.
 */
export const ANTHROPIC_WARNING_LATCH = Symbol.for("pi-account-manager.anthropicExtraUsageWarned");

type LatchHolder = Record<symbol, true | undefined>;

export type AuthState = "authenticated" | "not authenticated" | "status unavailable";

/** Reports only what pi reports. An unregistered alias or any failure is "status unavailable". */
export function authState(registry: ModelRegistry, id: string): AuthState {
	try {
		if (!registry.getProvider(id)) return "status unavailable";
		const status = registry.getProviderAuthStatus(id);
		if (typeof status?.configured !== "boolean") return "status unavailable";
		return status.configured ? "authenticated" : "not authenticated";
	} catch {
		return "status unavailable";
	}
}

export function anthropicWarningEnabled(ctx: ExtensionContext): boolean {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		return settings.getWarnings().anthropicExtraUsage !== false;
	} catch {
		// An unreadable setting must not silently disable the warning.
		return true;
	}
}

/**
 * Ownership is proven against the raw registered provider rather than the composed one:
 * pi returns the registered object untouched only when no models.json entry or extension
 * config overlays that ID, so comparing against `getProvider()` would report a legitimately
 * composed alias as foreign.
 */
function stillOurs(registry: ModelRegistry, id: string, ours: Provider | undefined): boolean {
	return ours !== undefined && registry.getRegisteredNativeProvider(id) === ours;
}

/** The subset of pi's registration surface this extension needs. */
interface Registrar {
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
}

/**
 * Builds every alias before registering any, so a base that cannot back an alias fails
 * before anything is registered, and unwinds if a registration itself throws.
 *
 * Note: at bootstrap pi queues these registrations and drains them later with a per-item
 * try/catch that logs and continues, so the unwind below only runs on the session_start
 * path. Bootstrap atomicity is pi's to give, not ours — which is also why the returned
 * providers are only *attempted* registrations until ownership is confirmed.
 */
function registerAll(
	registrar: Registrar,
	accounts: readonly Account[],
	base: (provider: ProviderId) => Provider | undefined,
): Map<string, Provider> {
	const aliases = accounts.map((account) => buildAlias(base(account.provider), account));
	const done = new Map<string, Provider>();
	try {
		for (const alias of aliases) {
			registrar.registerProvider(alias);
			done.set(alias.id, alias);
		}
	} catch (error) {
		for (const id of done.keys()) registrar.unregisterProvider(id);
		throw error;
	}
	return done;
}

export default async function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let snapshot: Account[] = [];
	let registered = new Map<string, Provider>();
	let loadError: string | undefined;

	const latch = globalThis as unknown as LatchHolder;

	const fail = (error: unknown) => {
		loadError = `Named accounts are unavailable: ${errorMessage(error)}`;
		snapshot = [];
		registered = new Map();
	};

	const isOwnAnthropicAlias = (providerId: string): boolean =>
		snapshot.some((account) => account.provider === "anthropic" && accountId(account) === providerId);

	/** Pi never warns for alias providers itself, and never emits model_select on restore. */
	const maybeWarnAnthropic = (ctx: ExtensionContext, providerId: string | undefined) => {
		if (ctx.mode !== "tui" || latch[ANTHROPIC_WARNING_LATCH]) return;
		if (!providerId || !isOwnAnthropicAlias(providerId)) return;
		if (authState(ctx.modelRegistry, providerId) !== "authenticated") return;
		if (!anthropicWarningEnabled(ctx)) return;
		latch[ANTHROPIC_WARNING_LATCH] = true;
		ctx.ui.notify(ANTHROPIC_EXTRA_USAGE_WARNING, "warning");
	};

	try {
		snapshot = await loadAccounts(agentDir);
		registered = registerAll(pi, snapshot, bundledProvider);
		await Promise.all(snapshot.map((account) => adoptNativeDefaultModel(account.provider, accountId(account))));
	} catch (error) {
		fail(error);
	}

	// Rebuild against the effective registry, which includes any models.json overlay that
	// the bundled factories know nothing about. Registered through `pi` rather than
	// ctx.modelRegistry so pi refreshes the live model object after the swap.
	pi.on("session_start", async (_event, ctx) => {
		if (!loadError && snapshot.length > 0) {
			const releaseOwned = (owned: Map<string, Provider>) => {
				for (const [id, provider] of owned) if (stillOurs(ctx.modelRegistry, id, provider)) pi.unregisterProvider(id);
			};
			const taken = snapshot
				.map(accountId)
				.filter((id) => !stillOurs(ctx.modelRegistry, id, registered.get(id)))
				.filter((id) => ctx.modelRegistry.getProvider(id) !== undefined);
			if (taken.length > 0) {
				releaseOwned(registered);
				fail(new Error(`provider ID "${taken[0]}" is already in use.`));
			} else {
				const previous = registered;
				try {
					registered = registerAll(pi, snapshot, (provider) => ctx.modelRegistry.getProvider(provider));
				} catch (error) {
					releaseOwned(previous);
					fail(error);
				}
			}
		}

		// A restored session assigns its model directly, with no model_select event, so
		// this is the only place a resumed alias model can be warned about.
		if (ctx.model && isOwnAnthropicAlias(ctx.model.provider)) {
			await ctx.modelRegistry.refresh();
			maybeWarnAnthropic(ctx, ctx.model.provider);
		}
	});

	// Pi reuses one ModelRuntime across /reload but gives the reloaded extension a fresh
	// closure, so without this the previous instance's aliases stay registered forever.
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "reload") return;
		for (const [id, provider] of registered) {
			if (stillOurs(ctx.modelRegistry, id, provider)) ctx.modelRegistry.unregisterProvider(id);
		}
		registered = new Map();
	});

	pi.on("model_select", (event, ctx) => maybeWarnAnthropic(ctx, event.model?.provider));

	const list = (ctx: ExtensionCommandContext) => {
		if (loadError) {
			ctx.ui.notify(loadError, "error");
			return;
		}
		ctx.ui.notify(
			formatList(snapshot, (account) => authState(ctx.modelRegistry, accountId(account))),
			"info",
		);
	};

	const add = async (ctx: ExtensionCommandContext, argument: string | undefined) => {
		const entered = argument ?? (await ctx.ui.input("Account name", "e.g. work"));
		if (entered === undefined) return;

		const name = normalizeName(entered);
		if (!isValidName(name)) {
			ctx.ui.notify(`Invalid account name "${entered.trim()}". ${NAME_RULE}`, "error");
			return;
		}

		const chosen = await ctx.ui.select("Provider", Object.values(PROVIDERS) as string[]);
		if (chosen === undefined) return;
		const provider = providerIdFor(chosen);
		if (!provider) return;

		const account: Account = { provider, name };
		const id = accountId(account);
		if (snapshot.some((existing) => accountId(existing) === id)) {
			ctx.ui.notify(`${id} already exists. Use /login ${id} to reauthenticate it.`, "error");
			return;
		}
		if (ctx.modelRegistry.getProvider(id) || ctx.modelRegistry.getRegisteredProviderIds().includes(id)) {
			ctx.ui.notify(`Cannot add ${id}: provider ID "${id}" is already in use.`, "error");
			return;
		}

		// Verified before anything is written, so a rejected add leaves nothing behind.
		let alias: Provider;
		try {
			alias = buildAlias(ctx.modelRegistry.getProvider(provider), account);
		} catch (error) {
			ctx.ui.notify(`Cannot add ${id}: ${errorMessage(error)}`, "error");
			return;
		}

		try {
			snapshot = await mutateAccounts(
				agentDir,
				snapshot,
				(accounts) => [...accounts, account],
				() => {
					pi.registerProvider(alias);
					registered.set(id, alias);
					return () => {
						pi.unregisterProvider(id);
						registered.delete(id);
					};
				},
			);
		} catch (error) {
			ctx.ui.notify(`Cannot add ${id}: ${errorMessage(error)}`, "error");
			return;
		}

		await adoptNativeDefaultModel(provider, id);

		const login = `/login ${id}`;
		if (ctx.ui.getEditorText().trim() === "") {
			ctx.ui.setEditorText(login);
			ctx.ui.notify(`Added ${id}. Submit the prepared command to sign in.`, "info");
		} else {
			ctx.ui.notify(`Added ${id}. Run ${login} to sign in.`, "info");
		}
	};

	const remove = async (ctx: ExtensionCommandContext, argument: string | undefined) => {
		const target = resolveRemoveTarget(snapshot, argument);
		if (target.kind === "none") {
			ctx.ui.notify(argument === undefined ? EMPTY_LIST : `No named account matches "${argument}".`, "error");
			return;
		}

		let account: Account;
		if (target.kind === "one") {
			account = target.account;
		} else {
			const chosen = await ctx.ui.select("Remove account", target.accounts.map(accountId));
			if (chosen === undefined) return;
			const picked = target.accounts.find((candidate) => accountId(candidate) === chosen);
			if (!picked) return;
			account = picked;
		}

		const id = accountId(account);
		const state = authState(ctx.modelRegistry, id);
		// Fail closed: never forget an account whose credential status we could not confirm.
		if (state === "status unavailable") {
			ctx.ui.notify(`Cannot remove ${id}: its authentication status is unavailable.`, "error");
			return;
		}

		const blockers: string[] = [];
		if (state === "authenticated") blockers.push(`Run /logout for ${id} first.`);
		if (ctx.model?.provider === id) blockers.push("Select another model with /model first.");
		if (blockers.length > 0) {
			ctx.ui.notify([`Cannot remove ${id}.`, ...blockers].join("\n"), "error");
			return;
		}

		try {
			snapshot = await mutateAccounts(
				agentDir,
				snapshot,
				(accounts) => accounts.filter((candidate) => accountId(candidate) !== id),
				() => {
					const ours = registered.get(id);
					// Never unregister a provider this extension does not own.
					if (stillOurs(ctx.modelRegistry, id, ours)) pi.unregisterProvider(id);
					registered.delete(id);
					return () => {
						if (ours) {
							pi.registerProvider(ours);
							registered.set(id, ours);
						}
					};
				},
			);
		} catch (error) {
			ctx.ui.notify(`Cannot remove ${id}: ${errorMessage(error)}`, "error");
			return;
		}

		ctx.ui.notify(`Removed ${id}. Its credential is untouched; use /logout to remove that.`, "info");
	};

	pi.registerCommand("account", {
		description: "Manage named OAuth accounts",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/account is available in interactive mode only.", "error");
				return;
			}
			const command = parseCommand(args);
			if (command.kind === "usage") {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			if (command.kind === "list") {
				list(ctx);
				return;
			}
			if (loadError) {
				ctx.ui.notify(`${loadError} Fix the account state, then run /reload.`, "error");
				return;
			}
			if (command.kind === "add") await add(ctx, command.name);
			else await remove(ctx, command.target);
		},
	});
}
