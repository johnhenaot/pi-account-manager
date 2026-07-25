import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Account, serializeState } from "../src/core.js";
import extension from "../src/index.js";
import { loadAccounts as loadStore } from "../src/store.js";
import { makeFakeCtx, makeFakePi } from "./fakes.js";

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
