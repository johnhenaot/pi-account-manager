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

import {
  parseAccountArgs, parseState, resolveRemoveTarget, serializeState,
} from "../src/core.js";

describe("parseState", () => {
  it("round-trips and canonicalizes", () => {
    const accounts: Account[] = [
      { provider: "openai-codex", name: "a" },
      { provider: "anthropic", name: "b" },
    ];
    const parsed = parseState(serializeState(accounts));
    expect(parsed.map(aliasId)).toEqual(["anthropic@b", "openai-codex@a"]);
    expect(JSON.parse(serializeState(accounts))).toEqual({
      version: 1,
      accounts: [
        { provider: "anthropic", name: "b" },
        { provider: "openai-codex", name: "a" },
      ],
    });
  });
  it("accepts the empty set", () => {
    expect(parseState('{"version":1,"accounts":[]}')).toEqual([]);
  });
  it("rejects every malformed shape with an error (no partial recovery)", () => {
    const bad = [
      "not json",
      "[]",
      '{"version":2,"accounts":[]}',
      '{"version":1}',
      '{"accounts":[]}',
      '{"version":1,"accounts":[],"extra":1}',
      '{"version":1,"accounts":[{"provider":"anthropic"}]}',
      '{"version":1,"accounts":[{"provider":"anthropic","name":"a","x":1}]}',
      '{"version":1,"accounts":[{"provider":"openai","name":"a"}]}',
      '{"version":1,"accounts":[{"provider":"anthropic","name":"Bad Name"}]}',
      '{"version":1,"accounts":[{"provider":"anthropic","name":"a"},{"provider":"anthropic","name":"a"}]}',
    ];
    for (const json of bad) expect(() => parseState(json), json).toThrow();
  });
});

describe("parseAccountArgs", () => {
  it("parses every documented form", () => {
    expect(parseAccountArgs("")).toEqual({ kind: "list" });
    expect(parseAccountArgs("  ")).toEqual({ kind: "list" });
    expect(parseAccountArgs("list")).toEqual({ kind: "list" });
    expect(parseAccountArgs("add")).toEqual({ kind: "add", name: undefined });
    expect(parseAccountArgs("add work")).toEqual({ kind: "add", name: "work" });
    expect(parseAccountArgs("remove")).toEqual({ kind: "remove", target: undefined });
    expect(parseAccountArgs("remove anthropic@work")).toEqual({ kind: "remove", target: "anthropic@work" });
  });
  it("rejects unknown subcommands and excess arguments", () => {
    for (const s of ["nope", "list extra", "add a b", "remove a b", "add a b c"]) {
      expect(parseAccountArgs(s)).toEqual({ kind: "usage" });
    }
  });
});

describe("resolveRemoveTarget", () => {
  const accounts: Account[] = [
    { provider: "anthropic", name: "work" },
    { provider: "openai-codex", name: "work" },
    { provider: "anthropic", name: "solo" },
  ];
  it("prefers exact case-sensitive alias id", () => {
    expect(resolveRemoveTarget("anthropic@work", accounts)).toEqual({
      kind: "account", account: { provider: "anthropic", name: "work" },
    });
  });
  it("does NOT alias-match case-insensitively (falls through to name matching)", () => {
    expect(resolveRemoveTarget("Anthropic@work", accounts).kind).toBe("none");
  });
  it("normalizes as name: one match", () => {
    expect(resolveRemoveTarget("  SOLO ", accounts)).toEqual({
      kind: "account", account: { provider: "anthropic", name: "solo" },
    });
  });
  it("normalizes as name: two matches -> choose", () => {
    const r = resolveRemoveTarget("work", accounts);
    expect(r.kind).toBe("choose");
    if (r.kind === "choose") expect(r.matches).toHaveLength(2);
  });
  it("no match or invalid input -> none", () => {
    expect(resolveRemoveTarget("ghost", accounts).kind).toBe("none");
    expect(resolveRemoveTarget("bad name!", accounts).kind).toBe("none");
  });
});
