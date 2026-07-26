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
	isValidName,
	NAME_RULE,
	normalizeName,
	PROVIDERS,
	type ProviderId,
	providerIdFor,
} from "./account.ts";
import { buildAlias, bundledProvider } from "./alias.ts";
import { parseCommand, resolveRemoveTarget, USAGE } from "./command.ts";
import { adoptNativeDefaultModel, forgetDefaultModel } from "./default-model.ts";
import { EMPTY_LIST, formatList } from "./list.ts";
import { loadAccounts, mutateAccounts } from "./state.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

export type AuthState = "authenticated" | "not authenticated" | "status unavailable";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/** The subset of pi's registration surface this extension needs. */
interface Registrar {
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
}

/** Builds every alias before registering any, then rolls back if a registration fails. */
function registerAll(
	registrar: Registrar,
	accounts: readonly Account[],
	base: (provider: ProviderId) => Provider | undefined,
): string[] {
	const aliases = accounts.map((account) => buildAlias(base(account.provider), account));
	const done: string[] = [];
	try {
		for (const alias of aliases) {
			registrar.registerProvider(alias);
			done.push(alias.id);
		}
	} catch (error) {
		for (const id of done) registrar.unregisterProvider(id);
		throw error;
	}
	return done;
}

export default async function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let snapshot: Account[] = [];
	let registered: string[] = [];
	let loadError: string | undefined;
	let warned = false;

	const fail = (error: unknown) => {
		loadError = `Named accounts are unavailable: ${describe(error)}`;
		snapshot = [];
		registered = [];
	};

	try {
		snapshot = await loadAccounts(agentDir);
		registered = registerAll(pi, snapshot, bundledProvider);
		await Promise.all(snapshot.map((account) => adoptNativeDefaultModel(account.provider, accountId(account))));
	} catch (error) {
		fail(error);
	}

	// Rebuild against the effective registry, which includes any models.json overlay that the
	// bundled factories know nothing about. All-or-none, like the bootstrap.
	pi.on("session_start", (_event, ctx) => {
		if (loadError || snapshot.length === 0) return;
		const previous = registered;
		try {
			registered = registerAll(ctx.modelRegistry, snapshot, (provider) => ctx.modelRegistry.getProvider(provider));
		} catch (error) {
			for (const id of previous) ctx.modelRegistry.unregisterProvider(id);
			fail(error);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (ctx.mode !== "tui" || warned) return;
		const isOwnAnthropicAlias = snapshot.some(
			(account) => account.provider === "anthropic" && accountId(account) === event.model.provider,
		);
		if (!isOwnAnthropicAlias) return;
		if (authState(ctx.modelRegistry, event.model.provider) !== "authenticated") return;
		if (!anthropicWarningEnabled(ctx)) return;
		warned = true;
		ctx.ui.notify(ANTHROPIC_EXTRA_USAGE_WARNING, "warning");
	});

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
			ctx.ui.notify(`Cannot add ${id}: ${describe(error)}`, "error");
			return;
		}

		try {
			snapshot = await mutateAccounts(
				agentDir,
				snapshot,
				(accounts) => [...accounts, account],
				() => {
					ctx.modelRegistry.registerProvider(alias);
					registered = [...registered, id];
				},
			);
		} catch (error) {
			ctx.ui.notify(`Cannot add ${id}: ${describe(error)}`, "error");
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
					ctx.modelRegistry.unregisterProvider(id);
					registered = registered.filter((candidate) => candidate !== id);
				},
			);
		} catch (error) {
			ctx.ui.notify(`Cannot remove ${id}: ${describe(error)}`, "error");
			return;
		}

		await forgetDefaultModel(id);
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
