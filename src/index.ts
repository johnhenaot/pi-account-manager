import type { Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
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
import { adoptNativeDefaultModel, releaseDefaultModel } from "./default-model.ts";
import { EMPTY_LIST, formatList } from "./list.ts";
import { loadAccounts, mutateAccounts } from "./state.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

// On globalThis, not the closure: `/reload` re-runs the factory in the same process and a
// local latch would let the once-per-process warning fire again.
export const ANTHROPIC_WARNING_LATCH = Symbol.for("pi-account-manager.anthropicExtraUsageWarned");
export const HOST_VERSION_LATCH = Symbol.for("pi-account-manager.hostVersionWarned");

// A peer range cannot express this: pi supplies the bundled packages at load time, so the
// package manager never sees which pi binary runs.
export const SUPPORTED_PI = "0.82";

type LatchHolder = Record<symbol, true | undefined>;

export type AuthState = "authenticated" | "not authenticated" | "status unavailable";

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

// Compared against the raw registered provider, not the composed one: pi returns the
// registered object untouched only when nothing overlays that ID, so `getProvider()` would
// report a legitimately composed alias as foreign.
function stillOurs(registry: ModelRegistry, id: string, ours: Provider | undefined): boolean {
	return ours !== undefined && registry.getRegisteredNativeProvider(id) === ours;
}

// Both forms matter: an ID can be registered while resolving to no effective provider, in
// which case getProvider() alone reports it free.
function occupiedByOther(registry: ModelRegistry, id: string, ours: Provider | undefined): boolean {
	if (stillOurs(registry, id, ours)) return false;
	return registry.getProvider(id) !== undefined || registry.getRegisteredProviderIds().includes(id);
}

interface Registrar {
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
}

// At bootstrap pi queues these and drains them itself, logging and continuing per item, so
// the unwind runs only on the session_start path and the returned providers are merely
// attempted until ownership is confirmed.
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

	// Pi never warns for alias providers itself, and never emits model_select on restore.
	const maybeWarnAnthropic = (ctx: ExtensionContext, providerId: string | undefined) => {
		if (ctx.mode !== "tui" || latch[ANTHROPIC_WARNING_LATCH]) return;
		if (!providerId || !isOwnAnthropicAlias(providerId)) return;
		if (authState(ctx.modelRegistry, providerId) !== "authenticated") return;
		if (!anthropicWarningEnabled(ctx)) return;
		latch[ANTHROPIC_WARNING_LATCH] = true;
		ctx.ui.notify(ANTHROPIC_EXTRA_USAGE_WARNING, "warning");
	};

	// Unconditional by necessity: ExtensionAPI has no provider lookup, so there is no point at
	// which this extension holds a registry and has not yet registered. A collision with an
	// earlier-loaded extension is therefore undetectable here; registering later instead would
	// forfeit startup model selection and `pi --list-models`. Ownership is enforced from
	// session_start onward, where a registry exists.
	try {
		snapshot = await loadAccounts(agentDir);
		registered = registerAll(pi, snapshot, bundledProvider);
		await Promise.all(snapshot.map((account) => adoptNativeDefaultModel(account.provider, accountId(account))));
	} catch (error) {
		fail(error);
	}

	// Rebuilt against the effective registry, which includes any models.json overlay. Through
	// `pi` rather than ctx.modelRegistry, because only that path refreshes the live model.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" && !latch[HOST_VERSION_LATCH] && !VERSION.startsWith(`${SUPPORTED_PI}.`)) {
			latch[HOST_VERSION_LATCH] = true;
			ctx.ui.notify(
				`pi-account-manager targets pi ${SUPPORTED_PI}; this host is ${VERSION}. Named accounts may not work correctly.`,
				"warning",
			);
		}

		if (!loadError && snapshot.length > 0) {
			/** Single exit for both giving-up paths, so neither can forget half the cleanup. */
			const abandon = async (owned: Map<string, Provider>, error: unknown) => {
				for (const [id, provider] of owned) {
					if (stillOurs(ctx.modelRegistry, id, provider)) pi.unregisterProvider(id);
				}
				// Before fail(), which clears the snapshot these IDs are derived from.
				await Promise.all(snapshot.map((account) => releaseDefaultModel(accountId(account))));
				fail(error);
			};

			const taken = snapshot
				.map(accountId)
				.filter((id) => occupiedByOther(ctx.modelRegistry, id, registered.get(id)));
			if (taken.length > 0) {
				await abandon(registered, new Error(`provider ID "${taken[0]}" is already in use.`));
			} else {
				const previous = registered;
				try {
					registered = registerAll(pi, snapshot, (provider) => ctx.modelRegistry.getProvider(provider));
				} catch (error) {
					await abandon(previous, error);
				}
			}
		}

		// A restored session assigns its model directly, emitting no model_select.
		if (ctx.model && isOwnAnthropicAlias(ctx.model.provider)) {
			// Only to make the auth snapshot current for an advisory warning, so a failure here
			// must not reject session_start and interfere with restoring the session.
			await ctx.modelRegistry.refresh().catch(() => {});
			maybeWarnAnthropic(ctx, ctx.model.provider);
		}
	});

	// Pi reuses one ModelRuntime across /reload but hands the reload a fresh closure, so
	// without this the previous instance's aliases stay registered forever.
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload") return;
		for (const [id, provider] of registered) {
			if (stillOurs(ctx.modelRegistry, id, provider)) ctx.modelRegistry.unregisterProvider(id);
		}
		await Promise.all([...registered.keys()].map(releaseDefaultModel));
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
		// An ID we already own means this is a duplicate account, which the locked check below
		// reports; only a foreign holder is an outright conflict.
		if (occupiedByOther(ctx.modelRegistry, id, registered.get(id))) {
			ctx.ui.notify(`Cannot add ${id}: provider ID "${id}" is already in use.`, "error");
			return;
		}

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
				(accounts) => {
					// Checked under the lock, after the stale comparison: telling the user to
					// /login an account another process already removed would orphan a credential.
					if (accounts.some((existing) => accountId(existing) === id)) {
						throw new Error(`already exists. Use /login ${id} to reauthenticate it.`);
					}
					return [...accounts, account];
				},
				() => {
					// Rechecked: the pre-flight check runs before the lock, so the ID can be claimed
					// while this command waits on contention.
					if (occupiedByOther(ctx.modelRegistry, id, registered.get(id))) {
						throw new Error(`provider ID "${id}" is already in use.`);
					}
					pi.registerProvider(alias);
					registered.set(id, alias);
					return () => {
						// The ID can change hands while the rename is pending, so unregister only
						// what is still ours.
						if (stillOurs(ctx.modelRegistry, id, alias)) pi.unregisterProvider(id);
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
		// Not trimmed: a fresh pi editor is exactly "", so whitespace is a real draft.
		if (ctx.ui.getEditorText() === "") {
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
		try {
			snapshot = await mutateAccounts(
				agentDir,
				snapshot,
				(accounts) => {
					// Under the lock, after the stale check: advising /logout for an account another
					// process already removed would destroy a credential its removal kept.
					const state = authState(ctx.modelRegistry, id);
					if (state === "status unavailable") throw new Error("its authentication status is unavailable.");

					const blockers: string[] = [];
					if (state === "authenticated") blockers.push(`Run /logout for ${id} first.`);
					if (ctx.model?.provider === id) blockers.push("Select another model with /model first.");
					if (blockers.length > 0) throw new Error(blockers.join("\n"));

					return accounts.filter((candidate) => accountId(candidate) !== id);
				},
				() => {
					const ours = registered.get(id);
					const unregistered = stillOurs(ctx.modelRegistry, id, ours);
					if (unregistered) pi.unregisterProvider(id);
					registered.delete(id);
					return () => {
						if (unregistered && ours) {
							// The freed ID may have been claimed while the rename was pending; a
							// rollback that cannot restore must be reported, not silently skipped.
							if (ctx.modelRegistry.getProvider(id) !== undefined) {
								throw new Error(`provider ID "${id}" was claimed before the removal could roll back.`);
							}
							pi.registerProvider(ours);
						}
						if (ours) registered.set(id, ours);
					};
				},
			);
		} catch (error) {
			ctx.ui.notify(`Cannot remove ${id}: ${errorMessage(error)}`, "error");
			return;
		}

		await releaseDefaultModel(id);
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
