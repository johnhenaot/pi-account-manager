import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Account, serializeState } from "../src/core.js";
import extension from "../src/index.js";
import { loadAccounts as loadStore } from "../src/store.js";
import { type AuthStatus, makeFakeCtx, makeFakePi } from "./fakes.js";

let agentDir: string;
const work: Account = { provider: "anthropic", name: "work" };
const personal: Account = { provider: "openai-codex", name: "personal" };

async function seed(accounts: Account[]) {
  await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
  await writeFile(
    join(agentDir, "pi-account-manager", "accounts.json"),
    serializeState(accounts),
    "utf8",
  );
}

const loadAccountsFile = () => loadStore(join(agentDir, "pi-account-manager", "accounts.json"));

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pam-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() honors this
});
afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

const effectiveRegistry = () =>
  new Map(
    builtinProviders()
      .filter((p) => p.id === "anthropic" || p.id === "openai-codex")
      .map((p) => [p.id, p]),
  );

describe("bootstrap", () => {
  it("phase 1 registers an alias per persisted account from bundled factories", async () => {
    await seed([work, personal]);
    const fake = makeFakePi();
    await extension(fake.pi);
    expect([...fake.providers.keys()].sort()).toEqual(["anthropic@work", "openai-codex@personal"]);
    expect(fake.providers.get("anthropic@work")!.auth.apiKey).toBeUndefined();
  });

  it("missing file means empty set, no registrations, no error", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    expect(fake.providers.size).toBe(0);
    const { ctx, notifications } = makeFakeCtx();
    await fake.account("", ctx);
    expect(notifications[0].message).toBe("No named accounts. Use /account add NAME.");
  });

  it("corrupt state: no alias loaded; /account reports the load error; add/remove refuse", async () => {
    await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
    await writeFile(join(agentDir, "pi-account-manager", "accounts.json"), '{"version":99}', "utf8");
    const fake = makeFakePi();
    await extension(fake.pi);
    expect(fake.providers.size).toBe(0);
    const { ctx, notifications } = makeFakeCtx();
    await fake.account("list", ctx);
    expect(notifications[0].message).toMatch(/version/);
    await fake.account("add work", makeFakeCtx().ctx); // must refuse, not prompt
    await fake.account("remove work", makeFakeCtx().ctx);
  });

  it("session_start replaces bundled aliases with effective-registry aliases (all-or-none)", async () => {
    await seed([work]);
    const fake = makeFakePi();
    await extension(fake.pi);
    const before = fake.providers.get("anthropic@work")!;
    const { ctx } = makeFakeCtx({ registry: effectiveRegistry() });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const after = fake.providers.get("anthropic@work")!;
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // replaced against effective providers
  });

  it("session_start failure unloads every alias and surfaces a load error", async () => {
    await seed([work, personal]);
    const fake = makeFakePi();
    await extension(fake.pi);
    const registry = effectiveRegistry();
    registry.delete("openai-codex"); // effective provider missing -> phase 2 must fail entirely
    const { ctx } = makeFakeCtx({ registry });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    expect(fake.providers.size).toBe(0);
    const list = makeFakeCtx();
    await fake.account("list", list.ctx);
    expect(list.notifications[0].type).toBe("error");
  });
});

describe("/account list", () => {
  it("refuses non-TUI modes without state change", async () => {
    await seed([work]);
    const fake = makeFakePi();
    await extension(fake.pi);
    for (const mode of ["rpc", "json", "print"]) {
      const { ctx, notifications } = makeFakeCtx({ mode });
      await fake.account("", ctx);
      expect(notifications[0].message).toMatch(/TUI/);
      expect(notifications[0].type).toBe("error");
    }
  });

  it("shows usage on unknown subcommand or excess args", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    for (const args of ["bogus", "list extra", "add a b"]) {
      const { ctx, notifications } = makeFakeCtx();
      await fake.account(args, ctx);
      expect(notifications[0].message).toMatch(/^Usage:/);
    }
  });

  it("lists rows ordered by provider display name then name, with one status each", async () => {
    await seed([personal, work, { provider: "anthropic", name: "alt" }]);
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications } = makeFakeCtx({
      authStatus: new Map<string, AuthStatus>([
        ["anthropic@alt", true],
        ["anthropic@work", false],
        ["openai-codex@personal", "throw"],
      ]),
    });
    await fake.account("list", ctx);
    const lines = notifications[0].message.split("\n");
    expect(lines[0]).toContain("anthropic@alt");
    expect(lines[0]).toContain("authenticated");
    expect(lines[1]).toContain("anthropic@work");
    expect(lines[1]).toContain("not authenticated");
    expect(lines[2]).toContain("openai-codex@personal");
    expect(lines[2]).toContain("status unavailable");
  });

  it("indeterminate status lookup shows status unavailable", async () => {
    await seed([work]);
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications } = makeFakeCtx({
      authStatus: new Map<string, AuthStatus>([["anthropic@work", "indeterminate"]]),
    });
    await fake.account("", ctx);
    expect(notifications[0].message).toContain("status unavailable");
  });
});

describe("/account add", () => {
  const addCtx = (over: Parameters<typeof makeFakeCtx>[0] = {}) =>
    makeFakeCtx({ registry: effectiveRegistry(), ...over });

  it("adds with explicit name: persists, registers, prefills empty editor", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, getEditor } = addCtx({ selections: ["Anthropic"] });
    await fake.account("add Work", ctx); // normalized to "work"
    expect(fake.providers.has("anthropic@work")).toBe(true);
    expect(getEditor()).toBe("/login anthropic@work");
    const list = makeFakeCtx();
    await fake.account("list", list.ctx);
    expect(list.notifications[0].message).toContain("anthropic@work");
  });

  it("preserves a non-empty editor and notifies with the exact login command", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications, getEditor } = addCtx({
      selections: ["OpenAI Codex"], editorText: "draft text",
    });
    await fake.account("add personal", ctx);
    expect(getEditor()).toBe("draft text");
    expect(notifications.at(-1)!.message).toContain("/login openai-codex@personal");
  });

  it("prompts for the name when omitted; cancelling either prompt changes nothing", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const c1 = addCtx({ inputs: [undefined] }); // cancel name prompt
    await fake.account("add", c1.ctx);
    const c2 = addCtx({ inputs: ["work"], selections: [undefined] }); // cancel provider prompt
    await fake.account("add", c2.ctx);
    expect(fake.providers.size).toBe(0);
    expect(await loadAccountsFile()).toEqual([]);
  });

  it("rejects invalid names", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications } = addCtx();
    await fake.account("add -bad-", ctx);
    expect(notifications[0].type).toBe("error");
    expect(fake.providers.size).toBe(0);
  });

  it("rejects an existing (provider,name) and suggests /login for reauth", async () => {
    await seed([work]);
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications } = addCtx({ selections: ["Anthropic"] });
    await fake.account("add work", ctx);
    expect(notifications[0].message).toContain("/login anthropic@work");
    expect(notifications[0].type).toBe("error");
  });

  it("fails cleanly when the alias id is already owned by another provider", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const registry = effectiveRegistry();
    registry.set("anthropic@work", registry.get("anthropic")!); // someone owns the id
    const { ctx, notifications } = addCtx({ registry, selections: ["Anthropic"] });
    await fake.account("add work", ctx);
    expect(notifications[0].type).toBe("error");
    expect(await loadAccountsFile()).toEqual([]); // nothing persisted
  });

  it("fails cleanly when the native provider is unavailable", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    const { ctx, notifications } = addCtx({ registry: new Map(), selections: ["Anthropic"] });
    await fake.account("add work", ctx);
    expect(notifications[0].type).toBe("error");
    expect(fake.providers.size).toBe(0);
    expect(await loadAccountsFile()).toEqual([]);
  });

  it("rolls back persistence when registration throws", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    fake.pi.registerProvider.mockImplementationOnce(() => { throw new Error("boom"); });
    const { ctx, notifications } = addCtx({ selections: ["Anthropic"] });
    await fake.account("add work", ctx);
    expect(notifications.at(-1)!.type).toBe("error");
    expect(await loadAccountsFile()).toEqual([]); // rolled back
  });

  it("aborts with /reload when disk state diverged (stale snapshot)", async () => {
    const fake = makeFakePi();
    await extension(fake.pi);
    await seed([personal]); // external process wrote after our load
    const { ctx, notifications } = addCtx({ selections: ["Anthropic"] });
    await fake.account("add work", ctx);
    expect(notifications.at(-1)!.message).toMatch(/\/reload/);
    expect((await loadAccountsFile()).map((a) => a.name)).toEqual(["personal"]); // untouched
  });
});

describe("/account remove", () => {
  const rmCtx = (over: Parameters<typeof makeFakeCtx>[0] = {}) =>
    makeFakeCtx({
      registry: effectiveRegistry(),
      authStatus: new Map<string, AuthStatus>([
        ["anthropic@work", false],
        ["openai-codex@personal", false],
        ["openai-codex@work", false],
      ]),
      ...over,
    });
  const setup = async (accounts: Account[]) => {
    await seed(accounts);
    const fake = makeFakePi();
    await extension(fake.pi);
    return fake;
  };

  it("removes by exact alias id: unregisters and forgets", async () => {
    const fake = await setup([work, personal]);
    const { ctx, notifications } = rmCtx();
    await fake.account("remove anthropic@work", ctx);
    expect(fake.providers.has("anthropic@work")).toBe(false);
    expect((await loadAccountsFile()).map((a) => a.name)).toEqual(["personal"]);
    expect(notifications.at(-1)!.message).toContain("anthropic@work");
  });

  it("no argument: selector over all accounts; cancellation changes nothing", async () => {
    const fake = await setup([work, personal]);
    const cancel = rmCtx({ selections: [undefined] });
    await fake.account("remove", cancel.ctx);
    expect((await loadAccountsFile()).length).toBe(2);
    const pickIt = rmCtx({ selections: ["Anthropic (work) — anthropic@work"] });
    await fake.account("remove", pickIt.ctx);
    expect((await loadAccountsFile()).map((a) => a.name)).toEqual(["personal"]);
  });

  it("one name match removes; two matches shows selector of those two", async () => {
    const fake = await setup([work, { provider: "openai-codex", name: "work" }]);
    const { ctx } = rmCtx({ selections: ["OpenAI Codex (work) — openai-codex@work"] });
    await fake.account("remove WORK", ctx); // normalized; 2 matches -> selector
    expect((await loadAccountsFile()).map(({ provider }) => provider)).toEqual(["anthropic"]);
  });

  it("no match makes no change", async () => {
    const fake = await setup([work]);
    const { ctx, notifications } = rmCtx();
    await fake.account("remove ghost", ctx);
    expect(notifications[0].type).toBe("error");
    expect((await loadAccountsFile()).length).toBe(1);
  });

  it("fails closed when auth status is unavailable", async () => {
    const fake = await setup([work]);
    const { ctx, notifications } = rmCtx({ authStatus: new Map<string, AuthStatus>([["anthropic@work", "throw"]]) });
    await fake.account("remove anthropic@work", ctx);
    expect(notifications[0].type).toBe("error");
    expect((await loadAccountsFile()).length).toBe(1);
  });

  it("refuses an authenticated account, instructing /logout", async () => {
    const fake = await setup([work]);
    const { ctx, notifications } = rmCtx({ authStatus: new Map<string, AuthStatus>([["anthropic@work", true]]) });
    await fake.account("remove anthropic@work", ctx);
    expect(notifications[0].message).toContain("/logout");
    expect((await loadAccountsFile()).length).toBe(1);
  });

  it("refuses the active model's account, instructing /model — both messages when both apply", async () => {
    const fake = await setup([work]);
    const active = rmCtx({ activeModelProvider: "anthropic@work" });
    await fake.account("remove anthropic@work", active.ctx);
    expect(active.notifications[0].message).toContain("/model");
    const both = rmCtx({
      authStatus: new Map<string, AuthStatus>([["anthropic@work", true]]),
      activeModelProvider: "anthropic@work",
    });
    await fake.account("remove anthropic@work", both.ctx);
    expect(both.notifications[0].message).toContain("/logout");
    expect(both.notifications[0].message).toContain("/model");
    expect((await loadAccountsFile()).length).toBe(1);
  });

  it("aborts with /reload when the target disappeared from disk", async () => {
    const fake = await setup([work]);
    await seed([]); // external removal
    const { ctx, notifications } = rmCtx();
    await fake.account("remove anthropic@work", ctx);
    expect(notifications.at(-1)!.message).toMatch(/\/reload/);
    expect(fake.providers.has("anthropic@work")).toBe(true); // runtime unchanged too
  });
});
