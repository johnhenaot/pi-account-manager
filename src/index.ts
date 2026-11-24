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

// A peer range cannot enforce this: pi loads its own bundled packages, so npm never sees which pi runs.
export const MIN_PI = "1.6.0";
export const meetsMinimum = (version: string): boolean =>
	version.localeCompare(MIN_PI, undefined, { numeric: true }) >= 0;

export const WARNED = Symbol.for("pi-account-manager.warned");
const warnedThisProcess = (): { anthropic?: true; version?: true } =>
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

	const registerAccountAliases = (base: (account: Account) => Parameters<typeof buildAlias>[0]) => {
		try {
			for (const account of snapshot) pi.registerProvider(buildAlias(base(account), account));
		} catch (error) {
			for (const account of snapshot) pi.unregisterProvider(accountId(account));
			loadError = `Named accounts are unavailable: ${errorMessage(error)}`;
			snapshot = [];
		}
	};

	try {
		snapshot = await loadAccounts(agentDir);
	} catch (error) {
		loadError = `Named accounts are unavailable: ${errorMessage(error)}`;
	}

	const cliModelCatalog = await startupProviders(
		agentDir,
		snapshot.map(({ provider }) => provider),
	);
	registerAccountAliases(({ provider }) => cliModelCatalog?.getProvider(provider) ?? bundledProvider(provider));

	const isOwnAnthropicAlias = (providerId: string | undefined): boolean =>
		snapshot.some((account) => account.provider === "anthropic" && accountId(account) === providerId);

	const maybeWarnAnthropic = (ctx: ExtensionContext, providerId: string | undefined) => {
		if (ctx.mode !== "tui" || warnedThisProcess().anthropic || !providerId || !isOwnAnthropicAlias(providerId)) return;
		if (!isAuthenticated(ctx.modelRegistry, providerId) || !anthropicWarningEnabled(ctx)) return;
		warnedThisProcess().anthropic = true;
		ctx.ui.notify(ANTHROPIC_EXTRA_USAGE_WARNING, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" && !warnedThisProcess().version && !meetsMinimum(VERSION)) {
			warnedThisProcess().version = true;
			ctx.ui.notify(
				`pi-account-manager requires pi ${MIN_PI} or newer; this host is ${VERSION}. Named accounts may not work correctly.`,
				"warning",
			);
		}

		// Registers through pi, not ctx.modelRegistry: only pi's path refreshes the session's live model.
		registerAccountAliases(({ provider }) => ctx.modelRegistry.getProvider(provider));

		if (isOwnAnthropicAlias(ctx.model?.provider)) {
			await ctx.modelRegistry.refresh().catch(() => {});
			maybeWarnAnthropic(ctx, ctx.model?.provider);
		}
	});

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
			const accountsOnDisk = await loadAccounts(agentDir);
			if (accountsOnDisk.some((existing) => accountId(existing) === id))
				throw new Error(`already exists. Use /login ${id} to reauthenticate it.`);
			if (ctx.modelRegistry.getProvider(id)) throw new Error(`provider ID "${id}" is already in use.`);
			const alias = buildAlias(ctx.modelRegistry.getProvider(provider), account);
			await saveAccounts(agentDir, [...accountsOnDisk, account]);
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
		const namedOneAccount = argument !== undefined && matches.length === 1;
		const id = namedOneAccount ? accountId(matches[0]) : await ctx.ui.select("Remove account", matches.map(accountId));
		if (id === undefined) return;

		const blockers: string[] = [];
		if (isAuthenticated(ctx.modelRegistry, id)) blockers.push(`Run /logout for ${id} first.`);
		if (ctx.model?.provider === id) blockers.push("Select another model with /model first.");
		try {
			if (blockers.length > 0) throw new Error(blockers.join("\n"));
			const accountsOnDisk = await loadAccounts(agentDir);
			await saveAccounts(
				agentDir,
				accountsOnDisk.filter((account) => accountId(account) !== id),
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
