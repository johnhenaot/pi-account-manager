import { describe, expect, it } from "vitest";
import {
  aliasDisplayName, aliasId, isValidName, normalizeName,
  sameAccounts, sortAccounts, type Account,
} from "../src/core.js";

describe("normalizeName", () => {
  it("trims and ASCII-lowercases", () => {
    expect(normalizeName("  Work ")).toBe("work");
    expect(normalizeName("A_B-9")).toBe("a_b-9");
  });
  it("lowercases ONLY ASCII A-Z (Kelvin sign K stays and later fails validation)", () => {
    expect(normalizeName("\u212A")).toBe("\u212A"); // .toLowerCase() would give "k" — wrong
    expect(isValidName(normalizeName("\u212A"))).toBe(false);
  });
});

describe("isValidName", () => {
  it("accepts spec names", () => {
    for (const n of ["a", "0", "work", "a-b_c", "a".repeat(32)]) expect(isValidName(n)).toBe(true);
  });
  it("rejects bad names", () => {
    for (const n of ["", "-a", "_a", "a".repeat(33), "A", "é", "a b", "a.b"]) expect(isValidName(n)).toBe(false);
  });
});

describe("alias identity", () => {
  const a: Account = { provider: "anthropic", name: "work" };
  const c: Account = { provider: "openai-codex", name: "personal" };
  it("builds spec examples", () => {
    expect(aliasId(a)).toBe("anthropic@work");
    expect(aliasId(c)).toBe("openai-codex@personal");
    expect(aliasDisplayName(a)).toBe("Anthropic (work)");
    expect(aliasDisplayName(c)).toBe("OpenAI Codex (personal)");
  });
});

describe("sortAccounts", () => {
  it("orders by provider display name then account name", () => {
    const input: Account[] = [
      { provider: "openai-codex", name: "a" },
      { provider: "anthropic", name: "z" },
      { provider: "anthropic", name: "a" },
    ];
    expect(sortAccounts(input).map(aliasId)).toEqual(["anthropic@a", "anthropic@z", "openai-codex@a"]);
  });
});

describe("sameAccounts", () => {
  it("is order-insensitive set equality on (provider,name)", () => {
    const x: Account[] = [{ provider: "anthropic", name: "a" }, { provider: "openai-codex", name: "a" }];
    expect(sameAccounts(x, [...x].reverse())).toBe(true);
    expect(sameAccounts(x, x.slice(1))).toBe(false);
  });
});
