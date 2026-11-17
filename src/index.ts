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
	isProviderId,
	isValidName,
	NAME_RULE,
	normalizeName,
	PROVIDERS,
	sortAccounts,
} from "./account.ts";
import { buildAlias, bundledProvider, startupProviders } from "./alias.ts";
import { loadAccounts, saveAccounts } from "./state.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

export const USAGE = [
	"Usage:",
	"  /account                        list named accounts",
	"  /account list                   list named accounts",
	"  /account add [name]             add a named account",
	"  /account remove [name|alias-id] remove a named account",
].join("\n");

export const EMPTY_LIST = "No named accounts. Use /account add NAME.";

// A peer range cannot express this: pi supplies the bundled packages at load time, so the
// package manager never sees which pi binary runs.
export const MIN_PI = "1.2.0";
export const meetsMinimum = (version: string): boolean =>
	version.localeCompare(MIN_PI, undefined, { numeric: true }) >= 0;

// On globalThis, not the closure: `/reload` re-runs the factory in the same process, and
// both warnings must fire at most once per process.
export const WARNED = Symbol.for("pi-account-manager.warned");
// SAFETY: only this extension's Symbol.for key is read or written on globalThis.
const warned = (): { anthropic?: true; version?: true } =>
	((globalThis as unknown as Record<symbol, object>)[WARNED] ??= {});

export function isAuthenticated(registry: ModelRegistry, id: string): boolean {
	try {
		return registry.getProviderAuthStatus(id)?.configured === true;
	} catch {
		return false;
	}
}

function anthropicWarningEnabled(ctx: ExtensionContext): boolean {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		return settings.getWarnings().anthropicExtraUsage !== false;
	} catch {
		// An unreadable setting must not silently disable the warning.
		return true;
	}
}

export function formatList(accounts: readonly Account[], registry: ModelRegistry): string {
	if (accounts.length === 0) return EMPTY_LIST;
	const rows = [
		["NAME", "PROVIDER", "ALIAS ID", "STATUS"],
		...accounts.map((account) => [
			account.name,
			PROVIDERS[account.provider],
			accountId(account),
			isAuthenticated(registry, accountId(account)) ? "authenticated" : "not authenticated",
		]),
	];
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	return rows
		.map((row) =>
			row
				.map((cell, i) => cell.padEnd(widths[i]))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export default async function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let snapshot: Account[] = [];
	let loadError: string | undefined;

	const registerAll = (base: (account: Account) => Parameters<typeof buildAlias>[0]) => {
		try {
			for (const account of snapshot) pi.registerProvider(buildAlias(base(account), account));
		} catch (error) {
			for (const account of snapshot) pi.unregisterProvider(accountId(account));
			loadError = `Named accounts are unavailable: ${errorMessage(error)}`;
			snapshot = [];
		}
	};

	// Registered at load so startup model selection and `pi --list-models` see the aliases.
	try {
		snapshot = await loadAccounts(agentDir);
	} catch (error) {
		loadError = `Named accounts are unavailable: ${errorMessage(error)}`;
	}
	// Built from the same models.json and catalog cache as pi's registry, which is not reachable yet.
	const startup = await startupProviders(
		agentDir,
		snapshot.map((account) => account.provider),
	);
	registerAll((account) => startup.get(account.provider) ?? bundledProvider(account.provider));

	const isOwnAnthropicAlias = (providerId: string | undefined): boolean =>
		snapshot.some((account) => account.provider === "anthropic" && accountId(account) === providerId);

	// Pi never warns for alias providers itself, and never emits model_select on restore.
	const maybeWarnAnthropic = (ctx: ExtensionContext, providerId: string | undefined) => {
		if (ctx.mode !== "tui" || warned().anthropic || !providerId || !isOwnAnthropicAlias(providerId)) return;
		if (!isAuthenticated(ctx.modelRegistry, providerId) || !anthropicWarningEnabled(ctx)) return;
		warned().anthropic = true;
		ctx.ui.notify(ANTHROPIC_EXTRA_USAGE_WARNING, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" && !warned().version && !meetsMinimum(VERSION)) {
			warned().version = true;
			ctx.ui.notify(
				`pi-account-manager requires pi ${MIN_PI} or newer; this host is ${VERSION}. Named accounts may not work correctly.`,
				"warning",
			);
		}

		// Rebuilt against the effective registry, which includes any models.json overlay. Through
		// `pi` rather than ctx.modelRegistry, because only that path refreshes the live model.
		registerAll((account) => ctx.modelRegistry.getProvider(account.provider));

		// A restored session assigns its model directly, emitting no model_select.
		if (isOwnAnthropicAlias(ctx.model?.provider)) {
			// Advisory only, so a refresh failure must not break session restore.
			await ctx.modelRegistry.refresh().catch(() => {});
			maybeWarnAnthropic(ctx, ctx.model?.provider);
		}
	});

	// Pi reuses one ModelRuntime across /reload but hands the reload a fresh closure, so
	// without this the previous instance's aliases stay registered forever.
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "reload") return;
		for (const account of snapshot) ctx.modelRegistry.unregisterProvider(accountId(account));
	});

	pi.on("model_select", (event, ctx) => maybeWarnAnthropic(ctx, event.model?.provider));

	const add = async (ctx: ExtensionCommandContext, argument: string | undefined) => {
		const entered = argument ?? (await ctx.ui.input("Account name", "e.g. work"));
		if (entered === undefined) return;
		const name = normalizeName(entered);
		if (!isValidName(name)) {
			ctx.ui.notify(`Invalid account name "${entered.trim()}". ${NAME_RULE}`, "error");
			return;
		}
		const label = await ctx.ui.select("Provider", Object.values(PROVIDERS));
		const provider = Object.keys(PROVIDERS).find((id) => PROVIDERS[id as keyof typeof PROVIDERS] === label);
		if (!provider || !isProviderId(provider)) return;

		const account: Account = { provider, name };
		const id = accountId(account);
		try {
			// Re-read so an account another pi process added since startup is kept.
			const accounts = await loadAccounts(agentDir);
			if (accounts.some((existing) => accountId(existing) === id))
				throw new Error(`already exists. Use /login ${id} to reauthenticate it.`);
			if (ctx.modelRegistry.getProvider(id)) throw new Error(`provider ID "${id}" is already in use.`);
			const alias = buildAlias(ctx.modelRegistry.getProvider(provider), account);
			await saveAccounts(agentDir, [...accounts, account]);
			snapshot = sortAccounts([...snapshot, account]);
			try {
				pi.registerProvider(alias);
			} catch (error) {
				throw new Error(`saved, but pi rejected the provider (${errorMessage(error)}). Run /reload.`);
			}
		} catch (error) {
			ctx.ui.notify(`Cannot add ${id}: ${errorMessage(error)}`, "error");
			return;
		}

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
		let matches = snapshot;
		if (argument !== undefined) {
			matches = snapshot.filter((account) => accountId(account) === argument);
			if (matches.length === 0) matches = snapshot.filter((account) => account.name === normalizeName(argument));
		}
		if (matches.length === 0) {
			ctx.ui.notify(argument === undefined ? EMPTY_LIST : `No named account matches "${argument}".`, "error");
			return;
		}
		// No argument always asks, so a lone account is never removed without confirmation.
		const id =
			argument !== undefined && matches.length === 1
				? accountId(matches[0])
				: await ctx.ui.select("Remove account", matches.map(accountId));
		if (id === undefined) return;

		const blockers: string[] = [];
		if (isAuthenticated(ctx.modelRegistry, id)) blockers.push(`Run /logout for ${id} first.`);
		if (ctx.model?.provider === id) blockers.push("Select another model with /model first.");
		try {
			if (blockers.length > 0) throw new Error(blockers.join("\n"));
			const accounts = await loadAccounts(agentDir);
			await saveAccounts(
				agentDir,
				accounts.filter((account) => accountId(account) !== id),
			);
			snapshot = snapshot.filter((account) => accountId(account) !== id);
			pi.unregisterProvider(id);
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
			const [command = "list", argument, extra] = args.trim().split(/\s+/).filter(Boolean);
			const valid =
				extra === undefined &&
				(command === "add" || command === "remove" || (command === "list" && argument === undefined));
			if (!valid) ctx.ui.notify(USAGE, "error");
			else if (command === "list")
				ctx.ui.notify(loadError ?? formatList(snapshot, ctx.modelRegistry), loadError ? "error" : "info");
			else if (loadError) ctx.ui.notify(`${loadError} Fix the account state, then run /reload.`, "error");
			else if (command === "add") await add(ctx, argument);
			else await remove(ctx, argument);
		},
	});
}
