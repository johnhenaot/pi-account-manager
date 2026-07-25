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
    ctx.ui.notify("add: implemented in Task 7", "error"); // replaced in Task 7
  }

  async function remove(target: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.notify("remove: implemented in Task 8", "error"); // replaced in Task 8
  }
}
