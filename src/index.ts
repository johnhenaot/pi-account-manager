import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { makeAlias } from "./alias.js";
import {
  type Account,
  PROVIDERS,
  type ProviderId,
  aliasDisplayName,
  aliasId,
  isValidName,
  normalizeName,
  parseAccountArgs,
  resolveRemoveTarget,
  sortAccounts,
} from "./core.js";
import { loadAccounts, mutateAccounts } from "./store.js";

const USAGE =
  "Usage: /account | /account list | /account add [name] | /account remove [name|alias-id]";
export const ANTHROPIC_WARNING =
  "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default async function (pi: ExtensionAPI) {
  const file = join(getAgentDir(), "pi-account-manager", "accounts.json");
  let accounts: Account[] = [];
  let loadError: string | undefined;
  const warned = false;

  type Bases = (id: ProviderId) => Provider | undefined;

  /** All-or-none: build every alias first, then register. Throws before any registration on failure. */
  function registerAll(bases: Bases): void {
    const aliases = accounts.map((a) => makeAlias(bases(a.provider), a));
    for (const alias of aliases) pi.registerProvider(alias);
  }

  function unloadAll(error: unknown): void {
    for (const a of accounts) {
      try {
        pi.unregisterProvider(aliasId(a));
      } catch {
        /* best effort: alias may not be registered */
      }
    }
    accounts = [];
    loadError = msg(error);
  }

  // Phase 1 (spec §6): validate persisted state and bootstrap against the exact bundled factories.
  try {
    accounts = await loadAccounts(file);
    const bundled = new Map(builtinProviders().map((p) => [p.id, p]));
    registerAll((id) => bundled.get(id));
  } catch (e) {
    unloadAll(e);
  }

  // Phase 2 (spec §6): before the first user command, replace every alias against the effective registry.
  pi.on("session_start", async (_event, ctx) => {
    if (loadError !== undefined) return;
    try {
      registerAll((id) => ctx.modelRegistry.getProvider(id));
    } catch (e) {
      unloadAll(e);
    }
  });

  function authStatusOf(
    ctx: ExtensionContext,
    id: string,
  ): "authenticated" | "not authenticated" | "status unavailable" {
    try {
      const s = ctx.modelRegistry.getProviderAuthStatus(id);
      if (typeof s?.configured !== "boolean") return "status unavailable";
      return s.configured ? "authenticated" : "not authenticated";
    } catch {
      return "status unavailable";
    }
  }

  function list(ctx: ExtensionCommandContext): void {
    if (loadError !== undefined) {
      ctx.ui.notify(`Named accounts failed to load: ${loadError}`, "error");
      return;
    }
    if (accounts.length === 0) {
      ctx.ui.notify("No named accounts. Use /account add NAME.", "info");
      return;
    }
    const rows = sortAccounts(accounts).map(
      (a) => `${a.name}  ${PROVIDERS[a.provider]}  ${aliasId(a)}  ${authStatusOf(ctx, aliasId(a))}`,
    );
    ctx.ui.notify(rows.join("\n"), "info");
  }

  // add() and remove() are implemented in Tasks 6-8; register the command now.
  pi.registerCommand("account", {
    description: "Manage named OAuth accounts: list, add, remove",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/account is only available in interactive TUI mode.", "error");
        return;
      }
      const cmd = parseAccountArgs(args ?? "");
      if (cmd.kind === "usage") {
        ctx.ui.notify(USAGE, "error");
        return;
      }
      if (cmd.kind === "list") {
        list(ctx);
        return;
      }
      if (loadError !== undefined) {
        ctx.ui.notify(
          `Named accounts failed to load: ${loadError}\nFix ${file}, then /reload before adding or removing accounts.`,
          "error",
        );
        return;
      }
      if (cmd.kind === "add") await add(cmd.name, ctx);
      else await remove(cmd.target, ctx);
    },
  });

  async function add(rawName: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
    const input = rawName ?? (await ctx.ui.input("Account name", "e.g. work"));
    if (input === undefined) return; // cancelled: no state change
    const name = normalizeName(input);
    if (!isValidName(name)) {
      ctx.ui.notify(
        `Invalid account name ${JSON.stringify(input)}. Use 1-32 of a-z 0-9 _ - starting with a letter or digit.`,
        "error",
      );
      return;
    }
    const label = await ctx.ui.select("Provider", Object.values(PROVIDERS));
    if (label === undefined) return; // cancelled: no state change
    const provider = (Object.keys(PROVIDERS) as ProviderId[]).find((p) => PROVIDERS[p] === label);
    if (!provider) return;
    const account: Account = { provider, name };
    const id = aliasId(account);
    if (accounts.some((a) => aliasId(a) === id)) {
      ctx.ui.notify(`${id} already exists. To reauthenticate, run /login ${id}.`, "error");
      return;
    }
    // Spec §3.2 step 5: effective provider + OAuth flow + catalog exist, alias id unowned,
    // and an OAuth-only alias is constructible (makeAlias enforces all of that).
    let alias: Provider;
    try {
      if (ctx.modelRegistry.getProvider(id)) throw new Error(`provider id "${id}" is already in use`);
      alias = makeAlias(ctx.modelRegistry.getProvider(provider), account);
    } catch (e) {
      ctx.ui.notify(`Cannot add ${id}: ${msg(e)}`, "error");
      return;
    }
    // Spec §3.2 step 6: persist + register all-or-nothing.
    let next: Account[];
    try {
      next = await mutateAccounts(file, accounts, (cur) => [...cur, account]);
    } catch (e) {
      ctx.ui.notify(`Add failed: ${msg(e)}`, "error");
      return;
    }
    try {
      pi.registerProvider(alias);
    } catch (e) {
      try {
        await mutateAccounts(file, next, (cur) => cur.filter((a) => aliasId(a) !== id));
      } catch {
        /* rollback is best effort; disk wins over runtime on next load */
      }
      ctx.ui.notify(`Add failed: ${msg(e)}`, "error");
      return;
    }
    accounts = next;
    // Spec §3.2 step 7: prepare /login without submitting it.
    const login = `/login ${id}`;
    if (ctx.ui.getEditorText() === "") {
      ctx.ui.setEditorText(login);
    } else {
      ctx.ui.notify(`Added ${id}. Run ${login} to authenticate.`, "info");
    }
  }

  async function pick(ctx: ExtensionCommandContext, from: Account[]): Promise<Account | undefined> {
    const sorted = sortAccounts(from);
    const labels = sorted.map((a) => `${aliasDisplayName(a)} — ${aliasId(a)}`);
    const choice = await ctx.ui.select("Remove which account?", labels);
    if (choice === undefined) return undefined; // cancelled
    return sorted[labels.indexOf(choice)];
  }

  async function remove(target: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
    let account: Account | undefined;
    if (target === undefined) {
      if (accounts.length === 0) {
        ctx.ui.notify("No named accounts. Use /account add NAME.", "info");
        return;
      }
      account = await pick(ctx, accounts);
    } else {
      const res = resolveRemoveTarget(target, accounts);
      if (res.kind === "none") {
        ctx.ui.notify(`No account matches ${JSON.stringify(target)}.`, "error");
        return;
      }
      account = res.kind === "account" ? res.account : await pick(ctx, res.matches);
    }
    if (!account) return; // cancelled: no state change
    const id = aliasId(account);

    // Spec §3.3: fail closed on status; refuse authenticated and active-model accounts.
    const status = authStatusOf(ctx, id);
    if (status === "status unavailable") {
      ctx.ui.notify(`Cannot verify authentication status for ${id}; not removing.`, "error");
      return;
    }
    const refusals: string[] = [];
    if (status === "authenticated") refusals.push(`${id} is authenticated. Run /logout first.`);
    if (ctx.model?.provider === id)
      refusals.push(`${id} is the active model's account. Run /model to switch first.`);
    if (refusals.length > 0) {
      ctx.ui.notify(refusals.join("\n"), "error");
      return;
    }

    let next: Account[];
    try {
      next = await mutateAccounts(file, accounts, (cur) => cur.filter((a) => aliasId(a) !== id));
    } catch (e) {
      ctx.ui.notify(`Remove failed: ${msg(e)}`, "error");
      return;
    }
    try {
      pi.unregisterProvider(id);
    } catch (e) {
      try {
        await mutateAccounts(file, next, (cur) => [...cur, account]);
      } catch {
        /* rollback is best effort; disk wins over runtime on next load */
      }
      ctx.ui.notify(`Remove failed: ${msg(e)}`, "error");
      return;
    }
    accounts = next;
    ctx.ui.notify(
      `Removed ${id}. Credentials for ${id} are untouched; use /login ${id} if you re-add it.`,
      "info",
    );
  }
}
