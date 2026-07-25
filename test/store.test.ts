import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/core.js";
import { StaleSnapshotError, loadAccounts, mutateAccounts } from "../src/store.js";

let dir: string;
let file: string;
const work: Account = { provider: "anthropic", name: "work" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pam-"));
  file = join(dir, "accounts.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("loadAccounts", () => {
  it("returns [] for a missing file", async () => {
    expect(await loadAccounts(file)).toEqual([]);
  });
  it("throws on corrupt content", async () => {
    await writeFile(file, "{nope", "utf8");
    await expect(loadAccounts(file)).rejects.toThrow();
  });
});

describe("mutateAccounts", () => {
  it("adds and persists canonically, creating parent dirs", async () => {
    const nested = join(dir, "sub", "accounts.json");
    const next = await mutateAccounts(nested, [], () => [work]);
    expect(next).toEqual([work]);
    expect(await loadAccounts(nested)).toEqual([work]);
    expect(await readFile(nested, "utf8")).toContain('"version": 1');
  });
  it("removes", async () => {
    await mutateAccounts(file, [], () => [work]);
    const next = await mutateAccounts(file, [work], () => []);
    expect(next).toEqual([]);
    expect(await loadAccounts(file)).toEqual([]);
  });
  it("aborts with /reload instruction when disk differs from snapshot (duplicate appeared)", async () => {
    await mutateAccounts(file, [], () => [work]); // disk now has work; caller snapshot still []
    await expect(mutateAccounts(file, [], (cur) => [...cur, work])).rejects.toThrow(StaleSnapshotError);
    await expect(mutateAccounts(file, [], (cur) => [...cur, work])).rejects.toThrow(/\/reload/);
    expect(await loadAccounts(file)).toEqual([work]); // untouched
  });
  it("aborts when the removal target disappeared", async () => {
    await expect(mutateAccounts(file, [work], (cur) => cur.filter(() => false)))
      .rejects.toThrow(StaleSnapshotError);
  });
  it("fails from lock contention within the budget, leaving state unchanged", async () => {
    await writeFile(`${file}.lock`, "held", "utf8"); // fresh foreign lock
    await expect(mutateAccounts(file, [], () => [work])).rejects.toThrow(/another/i);
    expect(await loadAccounts(file)).toEqual([]);
  }, 10_000);
  it("breaks a stale lock and proceeds", async () => {
    await writeFile(`${file}.lock`, "stale", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    expect(await mutateAccounts(file, [], () => [work])).toEqual([work]);
  });
  it("serializes concurrent writers (no lost update)", async () => {
    const codex: Account = { provider: "openai-codex", name: "a" };
    const results = await Promise.allSettled([
      mutateAccounts(file, [], (cur) => [...cur, work]),
      mutateAccounts(file, [], (cur) => [...cur, codex]),
    ]);
    // One wins; the other either also won (ran second on an unchanged-set? no — set changed) or aborted stale.
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const final = await loadAccounts(file);
    expect(final.length).toBe(ok.length); // every fulfilled writer's change survived exactly once
  });
});
