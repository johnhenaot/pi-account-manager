# Pi Account Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Pi extension that manages named OAuth account aliases (`anthropic@work`, `openai-codex@personal`) via `/account`, with credential-isolated provider aliases that plug into native `/login`, `/logout`, and `/model`.

**Architecture:** Four small source files. `core.ts` is pure logic (names, alias math, state schema, arg parsing, target resolution) — everything unit-testable without I/O. `store.ts` is file persistence with a lockfile and atomic rename, paths injected so tests never touch pi. `alias.ts` builds an OAuth-only provider alias by wrapping a base `Provider`. `index.ts` wires it all into `ExtensionAPI`: two-phase bootstrap (bundled factory, then effective registry at `session_start`), the `/account` command, and the Anthropic warning. No classes, no DI framework, no config — the spec's behavior only.

**Tech Stack:** TypeScript (run by pi via jiti, no build step), vitest for tests, `@earendil-works/pi-coding-agent` 0.82.0 + `@earendil-works/pi-ai` 0.82.0 as devDependencies (at runtime, pi aliases both imports to its bundled copies — verified in `dist/core/extensions/loader.js:getAliases()`, which also aliases the `@earendil-works/pi-ai/providers/all` subpath).

**Spec:** `docs/superpowers/specs/2026-07-24-pi-account-manager-design.md`. Every task implicitly includes the Global Constraints below.

## Global Constraints

- Providers: exactly `anthropic` ("Anthropic") and `openai-codex` ("OpenAI Codex"). Nothing else.
- Target `@earendil-works/pi-coding-agent` 0.82.0 and matching `@earendil-works/pi-ai` (0.82.0).
- Name normalization: `String.prototype.trim()`, then ASCII `A`–`Z` lowercasing ONLY (not `.toLowerCase()` — non-ASCII must be left alone so validation rejects it), then validate `^[a-z0-9][a-z0-9_-]{0,31}$`.
- Alias ID = `P + "@" + N`; alias display name = `D + " (" + N + ")"`.
- State file: `join(getAgentDir(), "pi-account-manager", "accounts.json")`, exact shape `{"version":1,"accounts":[{"provider":"...","name":"..."}]}`, canonical order by provider ID then name, strict validation (unknown fields / bad version / bad provider / bad name / duplicates ⇒ load error, no partial recovery). Missing file ⇒ empty set.
- All `/account` forms are TUI-only. Never override `/login`, `/logout`, `/model`. No renames, no API keys, no credential file access — auth status only via `ctx.modelRegistry.getProviderAuthStatus(id)`.
- Aliases are OAuth-only (`auth: { oauth }`, never `apiKey`), expose the base provider's models with `provider` remapped to the alias ID, and never fall back to another account.
- Cross-process mutations: complete or fail within 5 s, reread authoritative state under lock, abort with a `/reload` instruction on semantic snapshot mismatch, atomic rename for writes, runtime+persistent state change together or not at all.
- Empty-list message is exactly: `No named accounts. Use /account add NAME.`
- Anthropic warning text is exactly:
  `Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.`
- Tests never require live OAuth or network. Doubles may replace interaction/credential/transport boundaries; contract tests use the real 0.82 provider factories.

## File Structure

- Create: `package.json`, `tsconfig.json` — scaffolding (Task 1)
- Create: `src/core.ts` — pure logic (Tasks 1–2)
- Create: `src/store.ts` — persistence (Task 3)
- Create: `src/alias.ts` — alias construction (Task 4)
- Create: `src/index.ts` — extension entry, exports default factory (Tasks 5–9)
- Test: `test/core.test.ts`, `test/store.test.ts`, `test/alias.test.ts`, `test/extension.test.ts`
- Test helper: `test/fakes.ts` — fake `ExtensionAPI` / `ExtensionContext` doubles (Task 5)

Verified 0.82 API facts implementers need (do not re-derive):

- `getAgentDir()` honors `PI_CODING_AGENT_DIR` env var — tests set it to a temp dir.
- `ctx.modelRegistry.getProvider(id): Provider | undefined`, `.getProviderAuthStatus(id): { configured: boolean; source?; label? }` (throws/undefined possible for unknown providers).
- `pi.registerProvider(provider: Provider)` upserts by `provider.id`; `pi.unregisterProvider(id)`; both apply immediately after the initial load phase.
- `import { builtinProviders } from "@earendil-works/pi-ai/providers/all"` returns all bundled providers freshly constructed — this is "Pi 0.82's exact bundled provider factory".
- pi-ai `Provider` interface: `{ id, name, baseUrl?, headers?, auth: { apiKey?, oauth? }, getModels(), filterModels?, stream(), streamSimple() }`. `Model.provider` is what pi stamps on assistant messages/events, so remapping `provider` on models is what makes attribution work.
- `ctx.ui.select(title, options: string[]) => Promise<string|undefined>`, `ctx.ui.input(title, placeholder?) => Promise<string|undefined>` (undefined = cancelled), `ctx.ui.notify(msg, "info"|"warning"|"error")`, `ctx.ui.getEditorText()/setEditorText(text)`.
- `ctx.mode` is `"tui" | "rpc" | "json" | "print"`. `ctx.model` is the active model (has `.provider`).
- `SettingsManager.create(cwd, agentDir?, { projectTrusted }): SettingsManager` with `.getWarnings(): { anthropicExtraUsage?: boolean }`.
- `model_select` event: `{ model, previousModel, source: "set"|"cycle"|"restore" }` — fires for both selection and session restore.
- Session replacement (`/reload`, `/new`, `/resume`, `/fork`) re-runs the extension factory before emitting `session_start`, so factory-phase bootstrap always precedes each `session_start`.

---

### Task 1: Scaffolding + names, alias identity, ordering (pure core)

**Files:**

- Create: `package.json`, `tsconfig.json`
- Create: `src/core.ts`
- Test: `test/core.test.ts`

**Interfaces (produces):**

- `PROVIDERS: { anthropic: "Anthropic"; "openai-codex": "OpenAI Codex" }`, `type ProviderId`, `interface Account { provider: ProviderId; name: string }`
- `normalizeName(raw: string): string`, `isValidName(name: string): boolean`, `isProviderId(x: string): x is ProviderId`
- `aliasId(a: Account): string`, `aliasDisplayName(a: Account): string`
- `sortAccounts(list: readonly Account[]): Account[]`, `sameAccounts(a, b): boolean`

- [ ] **Step 1: Write scaffolding**

`package.json`:

```json
{
  "name": "pi-account-manager",
  "version": "0.1.0",
  "type": "module",
  "description": "Pi extension for managing multiple named OAuth accounts per provider",
  "pi": { "extensions": ["./src/index.ts"] },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-ai": "0.82.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`test/core.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/core.test.ts`
Expected: FAIL — cannot resolve `../src/core.js`.

- [ ] **Step 4: Write the implementation**

`src/core.ts`:

```typescript
export const PROVIDERS = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export interface Account {
  provider: ProviderId;
  name: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** trim + ASCII A-Z lowercase only (spec §2). Not .toLowerCase(): U+212A etc. must stay put so validation rejects them. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isProviderId(x: string): x is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, x);
}

export const aliasId = (a: Account): string => `${a.provider}@${a.name}`;
export const aliasDisplayName = (a: Account): string => `${PROVIDERS[a.provider]} (${a.name})`;

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function sortAccounts(list: readonly Account[]): Account[] {
  return [...list].sort(
    (a, b) => cmp(PROVIDERS[a.provider], PROVIDERS[b.provider]) || cmp(a.name, b.name),
  );
}

export function sameAccounts(a: readonly Account[], b: readonly Account[]): boolean {
  const key = (l: readonly Account[]) => sortAccounts(l).map(aliasId).join("\n");
  return key(a) === key(b);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json src/core.ts test/core.test.ts package-lock.json
git commit -m "feat: scaffold extension; name normalization, alias identity, ordering"
```

---

### Task 2: State schema + command parsing + remove-target resolution (pure core)

**Files:**

- Modify: `src/core.ts` (append)
- Test: `test/core.test.ts` (append)

**Interfaces (produces):**

- `parseState(json: string): Account[]` — throws `Error` with a descriptive message on any invalid input; returns canonically sorted accounts
- `serializeState(accounts: readonly Account[]): string`
- `type AccountCommand = { kind: "list" } | { kind: "add"; name?: string } | { kind: "remove"; target?: string } | { kind: "usage" }`
- `parseAccountArgs(args: string): AccountCommand`
- `type RemoveResolution = { kind: "account"; account: Account } | { kind: "choose"; matches: Account[] } | { kind: "none" }`
- `resolveRemoveTarget(target: string, accounts: readonly Account[]): RemoveResolution`

- [ ] **Step 1: Write the failing tests**

Append to `test/core.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core.test.ts`
Expected: FAIL — `parseState` etc. not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/core.ts`:

```typescript
/** Strict accounts.json parser (spec §6). Any deviation throws — no partial recovery. */
export function parseState(json: string): Account[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("invalid JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("top-level value must be an object");
  }
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).sort().join(",") !== "accounts,version") {
    throw new Error("top-level object must contain exactly version and accounts");
  }
  if (obj.version !== 1) throw new Error(`unsupported version: ${JSON.stringify(obj.version)}`);
  if (!Array.isArray(obj.accounts)) throw new Error("accounts must be an array");
  const accounts: Account[] = [];
  const seen = new Set<string>();
  for (const entry of obj.accounts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each account must be an object");
    }
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "name,provider") {
      throw new Error("each account must contain exactly provider and name");
    }
    if (typeof e.provider !== "string" || !isProviderId(e.provider)) {
      throw new Error(`unsupported provider: ${JSON.stringify(e.provider)}`);
    }
    if (typeof e.name !== "string" || !isValidName(e.name)) {
      throw new Error(`invalid account name: ${JSON.stringify(e.name)}`);
    }
    const account: Account = { provider: e.provider, name: e.name };
    const id = aliasId(account);
    if (seen.has(id)) throw new Error(`duplicate account: ${id}`);
    seen.add(id);
    accounts.push(account);
  }
  return sortAccounts(accounts);
}

export function serializeState(accounts: readonly Account[]): string {
  return `${JSON.stringify(
    { version: 1, accounts: sortAccounts(accounts).map(({ provider, name }) => ({ provider, name })) },
    null,
    2,
  )}\n`;
}

export type AccountCommand =
  | { kind: "list" }
  | { kind: "add"; name?: string }
  | { kind: "remove"; target?: string }
  | { kind: "usage" };

export function parseAccountArgs(args: string): AccountCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 2) return { kind: "usage" };
  const [sub, arg] = parts;
  if (sub === undefined) return { kind: "list" };
  if (sub === "list") return arg === undefined ? { kind: "list" } : { kind: "usage" };
  if (sub === "add") return { kind: "add", name: arg };
  if (sub === "remove") return { kind: "remove", target: arg };
  return { kind: "usage" };
}

export type RemoveResolution =
  | { kind: "account"; account: Account }
  | { kind: "choose"; matches: Account[] }
  | { kind: "none" };

/** Spec §3.3 target resolution: exact alias id, else normalized-name match. */
export function resolveRemoveTarget(target: string, accounts: readonly Account[]): RemoveResolution {
  const exact = accounts.find((a) => aliasId(a) === target);
  if (exact) return { kind: "account", account: exact };
  const name = normalizeName(target);
  if (!isValidName(name)) return { kind: "none" };
  const matches = sortAccounts(accounts.filter((a) => a.name === name));
  if (matches.length === 1) return { kind: "account", account: matches[0] };
  if (matches.length >= 2) return { kind: "choose", matches };
  return { kind: "none" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core.test.ts && npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/core.ts test/core.test.ts
git commit -m "feat: strict state schema, /account arg parsing, remove-target resolution"
```

---

### Task 3: Persistence — load, lock, atomic mutate

**Files:**

- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**

- Consumes: `parseState`, `serializeState`, `sameAccounts`, `sortAccounts`, `Account` from `src/core.ts`
- Produces:
  - `loadAccounts(file: string): Promise<Account[]>` — `[]` when missing; throws parse/IO errors verbatim
  - `mutateAccounts(file: string, snapshot: readonly Account[], change: (current: Account[]) => Account[]): Promise<Account[]>` — locks, rereads, compares against snapshot (throws `StaleSnapshotError` mentioning `/reload` on semantic mismatch), applies `change`, atomic-writes, returns new canonical list
  - `class StaleSnapshotError extends Error`
  - `LOCK_TIMEOUT_MS = 5000` exported for tests

- [ ] **Step 1: Write the failing tests**

`test/store.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 3: Write the implementation**

`src/store.ts`:

```typescript
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Account, parseState, sameAccounts, serializeState, sortAccounts } from "./core.js";

export const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;

export class StaleSnapshotError extends Error {}

export async function loadAccounts(file: string): Promise<Account[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return parseState(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

// ponytail: O_EXCL lockfile + 100ms polling; proper fcntl locks if this ever needs more than "two pi processes".
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const mtime = await stat(lock).then((s) => s.mtimeMs, () => undefined);
      if (mtime !== undefined && Date.now() - mtime > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("accounts.json is locked by another process; try again shortly");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Locked read-modify-write (spec §6). Rereads authoritative state, aborts on
 * semantic mismatch with the caller's snapshot, atomic-renames the new state.
 */
export async function mutateAccounts(
  file: string,
  snapshot: readonly Account[],
  change: (current: Account[]) => Account[],
): Promise<Account[]> {
  return withLock(file, async () => {
    const current = await loadAccounts(file);
    if (!sameAccounts(current, snapshot)) {
      throw new StaleSnapshotError(
        "Account state changed outside this process. Run /reload, then retry.",
      );
    }
    const next = sortAccounts(change(current));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, serializeState(next), "utf8");
    await rename(tmp, file);
    return next;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.ts && npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: locked atomic accounts.json persistence with stale-snapshot abort"
```

---

### Task 4: Alias construction + contract tests against real 0.82 factories

**Files:**

- Create: `src/alias.ts`
- Test: `test/alias.test.ts`

**Interfaces:**

- Consumes: `Account`, `aliasId`, `aliasDisplayName` from `src/core.ts`; pi-ai `Provider` type
- Produces: `makeAlias(base: Provider | undefined, account: Account): Provider` — throws when base is missing, has no OAuth flow, or has an empty model catalog. Never includes `apiKey` auth.

- [ ] **Step 1: Write the failing tests** (contract tests: real bundled factories, no network)

`test/alias.test.ts`:

```typescript
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { makeAlias } from "../src/alias.js";
import type { Account } from "../src/core.js";

const bundled = new Map(builtinProviders().map((p) => [p.id, p]));
const anthropic = bundled.get("anthropic")!;
const codex = bundled.get("openai-codex")!;
const work: Account = { provider: "anthropic", name: "work" };

describe("makeAlias (contract: real Pi 0.82 bundled factories)", () => {
  it("bundled anthropic and openai-codex providers exist and have OAuth", () => {
    expect(anthropic.auth.oauth).toBeDefined();
    expect(codex.auth.oauth).toBeDefined();
  });

  it("builds an OAuth-only alias with spec identity", () => {
    const alias = makeAlias(anthropic, work);
    expect(alias.id).toBe("anthropic@work");
    expect(alias.name).toBe("Anthropic (work)");
    expect(alias.auth.oauth).toBe(anthropic.auth.oauth);
    expect(alias.auth.apiKey).toBeUndefined(); // no API-key/env fallback, ever (spec §4.1/§5)
  });

  it("exposes exactly the base models with provider remapped to the alias id", () => {
    for (const [base, account] of [
      [anthropic, work],
      [codex, { provider: "openai-codex", name: "personal" }],
    ] as [Provider, Account][]) {
      const alias = makeAlias(base, account);
      const baseModels = base.getModels();
      const aliasModels = alias.getModels();
      expect(aliasModels.length).toBe(baseModels.length);
      for (let i = 0; i < baseModels.length; i++) {
        const { provider: bp, ...restBase } = baseModels[i];
        const { provider: ap, ...restAlias } = aliasModels[i];
        expect(ap).toBe(`${account.provider}@${account.name}`); // attribution (spec §5)
        expect(restAlias).toEqual(restBase); // ids, names, caps, limits, costs, compat all equal
      }
    }
  });

  it("reflects base catalog changes on later getModels() calls (no snapshotting)", () => {
    let models = anthropic.getModels().slice(0, 1);
    const fakeBase: Provider = { ...anthropic, getModels: () => models };
    const alias = makeAlias(fakeBase, work);
    expect(alias.getModels()).toHaveLength(1);
    models = anthropic.getModels().slice(0, 2);
    expect(alias.getModels()).toHaveLength(2);
  });

  it("delegates stream/streamSimple to the base provider with the alias model", () => {
    const calls: unknown[] = [];
    const fakeBase = {
      ...anthropic,
      stream: (...args: unknown[]) => { calls.push(["stream", args[0]]); return "S" as never; },
      streamSimple: (...args: unknown[]) => { calls.push(["simple", args[0]]); return "SS" as never; },
    } as Provider;
    const alias = makeAlias(fakeBase, work);
    const model = alias.getModels()[0];
    expect(alias.stream(model as never, { messages: [] } as never)).toBe("S");
    expect(alias.streamSimple(model, { messages: [] } as never)).toBe("SS");
    // The alias model (provider = alias id) is passed through so pi-ai stamps the alias id
    // on every assistant stream event and finalized message (spec §5).
    expect(calls).toEqual([["stream", model], ["simple", model]]);
  });

  it("throws for missing base, missing OAuth, empty catalog", () => {
    expect(() => makeAlias(undefined, work)).toThrow(/not available/);
    expect(() => makeAlias({ ...anthropic, auth: { apiKey: anthropic.auth.apiKey } } as Provider, work))
      .toThrow(/OAuth/);
    expect(() => makeAlias({ ...anthropic, getModels: () => [] } as Provider, work))
      .toThrow(/model catalog/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/alias.test.ts`
Expected: FAIL — cannot resolve `../src/alias.js`.

- [ ] **Step 3: Write the implementation**

`src/alias.ts`:

```typescript
import type { Provider } from "@earendil-works/pi-ai";
import { type Account, aliasDisplayName, aliasId } from "./core.js";

/**
 * Build an OAuth-only alias of a native provider (spec §5).
 * Credentials isolate automatically: pi's credential store keys by Provider.id,
 * and the alias id is the account's alias id.
 */
export function makeAlias(base: Provider | undefined, account: Account): Provider {
  if (!base) throw new Error(`native provider "${account.provider}" is not available`);
  const oauth = base.auth.oauth;
  if (!oauth) throw new Error(`provider "${account.provider}" has no OAuth flow`);
  if (base.getModels().length === 0) {
    throw new Error(`provider "${account.provider}" has an empty model catalog`);
  }
  const id = aliasId(account);
  return {
    id,
    name: aliasDisplayName(account),
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: { oauth }, // OAuth only: no apiKey member means no env-var or ambient fallback
    getModels: () => base.getModels().map((m) => ({ ...m, provider: id })),
    ...(base.filterModels ? { filterModels: base.filterModels.bind(base) } : {}),
    stream: (model, context, options) => base.stream(model as never, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model as never, context, options),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/alias.test.ts && npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/alias.ts test/alias.test.ts
git commit -m "feat: OAuth-only provider alias construction with model attribution remap"
```

---

### Task 5: Extension entry — two-phase bootstrap, load-error handling, test fakes

**Files:**

- Create: `src/index.ts`
- Create: `test/fakes.ts`
- Test: `test/extension.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–4; `getAgentDir`, `ExtensionAPI` from pi; `builtinProviders` from `@earendil-works/pi-ai/providers/all`
- Produces:
  - `export default async function (pi: ExtensionAPI)` — the extension
  - Internal per-instance state object visible to later tasks: `accounts: Account[]`, `loadError: string | undefined`, `warned: boolean`, `file: string`
  - `test/fakes.ts`: `makeFakePi()` and `makeFakeCtx()` used by Tasks 5–9

- [ ] **Step 1: Write the test fakes**

`test/fakes.ts`:

```typescript
import type { Provider } from "@earendil-works/pi-ai";
import { vi } from "vitest";

/** Captures registrations; enough ExtensionAPI surface for this extension. */
export function makeFakePi() {
  const providers = new Map<string, Provider>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const pi = {
    registerProvider: vi.fn((p: Provider) => { providers.set(p.id, p); }),
    unregisterProvider: vi.fn((id: string) => { providers.delete(id); }),
    registerCommand: vi.fn((name: string, opts: any) => { commands.set(name, opts); }),
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
  };
  return {
    pi: pi as never,
    providers,
    commands,
    emit: async (event: string, eventArg: any, ctx: any) => {
      for (const h of handlers.get(event) ?? []) await h(eventArg, ctx);
    },
    account: (args: string, ctx: any) => commands.get("account")!.handler(args, ctx),
  };
}

export interface FakeCtxOptions {
  mode?: string;
  cwd?: string;
  /** provider id -> Provider for modelRegistry.getProvider */
  registry?: Map<string, Provider>;
  /** provider id -> boolean (configured) | "throw" | "indeterminate" */
  authStatus?: Map<string, boolean | "throw" | "indeterminate">;
  /** scripted answers for ui.input then ui.select, consumed in order */
  inputs?: (string | undefined)[];
  selections?: (string | undefined)[];
  activeModelProvider?: string;
  editorText?: string;
  projectTrusted?: boolean;
}

export function makeFakeCtx(opts: FakeCtxOptions = {}) {
  const notifications: { message: string; type?: string }[] = [];
  const inputs = [...(opts.inputs ?? [])];
  const selections = [...(opts.selections ?? [])];
  let editorText = opts.editorText ?? "";
  const ctx = {
    mode: opts.mode ?? "tui",
    cwd: opts.cwd ?? "/tmp",
    isProjectTrusted: () => opts.projectTrusted ?? false,
    model: opts.activeModelProvider ? { provider: opts.activeModelProvider } : undefined,
    modelRegistry: {
      getProvider: (id: string) => opts.registry?.get(id),
      getProviderAuthStatus: (id: string) => {
        const v = opts.authStatus?.get(id);
        if (v === "throw") throw new Error("auth store unavailable");
        if (v === "indeterminate" || v === undefined) return undefined as never;
        return { configured: v };
      },
    },
    ui: {
      notify: (message: string, type?: string) => { notifications.push({ message, type }); },
      input: async () => inputs.shift(),
      select: async () => selections.shift(),
      getEditorText: () => editorText,
      setEditorText: (t: string) => { editorText = t; },
    },
  };
  return { ctx: ctx as never as any, notifications, getEditor: () => editorText };
}
```

- [ ] **Step 2: Write the failing tests**

`test/extension.test.ts` (bootstrap portion; later tasks append):

```typescript
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import extension from "../src/index.js";
import { serializeState, type Account } from "../src/core.js";
import { makeFakeCtx, makeFakePi } from "./fakes.js";

let agentDir: string;
const work: Account = { provider: "anthropic", name: "work" };
const personal: Account = { provider: "openai-codex", name: "personal" };

async function seed(accounts: Account[]) {
  await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
  await writeFile(join(agentDir, "pi-account-manager", "accounts.json"), serializeState(accounts), "utf8");
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pam-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() honors this
});
afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

const effectiveRegistry = () =>
  new Map(builtinProviders().filter((p) => p.id === "anthropic" || p.id === "openai-codex").map((p) => [p.id, p]));

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Write the implementation**

`src/index.ts`:

```typescript
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeAlias } from "./alias.js";
import {
  PROVIDERS,
  aliasDisplayName,
  aliasId,
  isValidName,
  normalizeName,
  parseAccountArgs,
  resolveRemoveTarget,
  sortAccounts,
  type Account,
  type ProviderId,
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
  let warned = false;

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

  function authStatusOf(ctx: ExtensionContext, id: string): "authenticated" | "not authenticated" | "status unavailable" {
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
```

Note: the two stubs are the only forward references in this plan; Tasks 7 and 8 replace their bodies entirely. The Task 5 test that calls `add`/`remove` on a load error passes because the load-error guard runs before the stubs.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/extension.test.ts && npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/fakes.ts test/extension.test.ts
git commit -m "feat: extension entry with two-phase all-or-none alias bootstrap"
```

---

### Task 6: `/account` list + TUI guard + usage

**Files:**

- Modify: `src/index.ts` (behavior already written in Task 5 — this task locks it in with tests)
- Test: `test/extension.test.ts` (append)

**Interfaces:** consumes the Task 5 `fake.account(args, ctx)` helper.

- [ ] **Step 1: Write the failing tests**

Append to `test/extension.test.ts`:

```typescript
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
      authStatus: new Map([
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
      authStatus: new Map([["anthropic@work", "indeterminate"]]),
    });
    await fake.account("", ctx);
    expect(notifications[0].message).toContain("status unavailable");
  });
});
```

- [ ] **Step 2: Run tests** — Run: `npx vitest run test/extension.test.ts`. Expected: PASS already (Task 5 implemented list). If any fail, fix `list()` / `authStatusOf()` in `src/index.ts` until green — the tests are the contract.

- [ ] **Step 3: Commit**

```bash
git add test/extension.test.ts
git commit -m "test: /account list ordering, statuses, TUI guard, usage"
```

---

### Task 7: `/account add`

**Files:**

- Modify: `src/index.ts` — replace the `add` stub
- Test: `test/extension.test.ts` (append)

**Interfaces:** consumes `mutateAccounts`, `makeAlias`, `ctx.ui.input/select/getEditorText/setEditorText`, `ctx.modelRegistry.getProvider`.

- [ ] **Step 1: Write the failing tests**

Append to `test/extension.test.ts`:

```typescript
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
```

Add this helper near `seed` at the top of `test/extension.test.ts`:

```typescript
import { loadAccounts as loadStore } from "../src/store.js";
const loadAccountsFile = () => loadStore(join(agentDir, "pi-account-manager", "accounts.json"));
```

(Note: `fake.pi.registerProvider` is a vitest mock — type the `pi` in `makeFakePi`'s return as `any` if TS complains about `mockImplementationOnce`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL — add stub notifies "implemented in Task 7".

- [ ] **Step 3: Replace the `add` stub in `src/index.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all suites PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat: /account add with verification, atomic persist+register, editor prep"
```

---

### Task 8: `/account remove`

**Files:**

- Modify: `src/index.ts` — replace the `remove` stub, add `pick` helper
- Test: `test/extension.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/extension.test.ts`:

```typescript
describe("/account remove", () => {
  const rmCtx = (over: Parameters<typeof makeFakeCtx>[0] = {}) =>
    makeFakeCtx({
      registry: effectiveRegistry(),
      authStatus: new Map([["anthropic@work", false], ["openai-codex@personal", false], ["openai-codex@work", false]]),
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
    const { ctx, notifications } = rmCtx({ authStatus: new Map([["anthropic@work", "throw"]]) });
    await fake.account("remove anthropic@work", ctx);
    expect(notifications[0].type).toBe("error");
    expect((await loadAccountsFile()).length).toBe(1);
  });

  it("refuses an authenticated account, instructing /logout", async () => {
    const fake = await setup([work]);
    const { ctx, notifications } = rmCtx({ authStatus: new Map([["anthropic@work", true]]) });
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
      authStatus: new Map([["anthropic@work", true]]),
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL — remove stub notifies "implemented in Task 8".

- [ ] **Step 3: Replace the `remove` stub in `src/index.ts`**

```typescript
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
    if (ctx.model?.provider === id) refusals.push(`${id} is the active model's account. Run /model to switch first.`);
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
    ctx.ui.notify(`Removed ${id}. Credentials for ${id} are untouched; use /login ${id} if you re-add it.`, "info");
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat: /account remove with fail-closed refusals and atomic unregister+forget"
```

---

### Task 9: Anthropic extra-usage warning

**Files:**

- Modify: `src/index.ts` — add `model_select` handler + settings read
- Test: `test/extension.test.ts` (append)

**Interfaces:** consumes `SettingsManager.create`, `model_select` event, `ANTHROPIC_WARNING` export from Task 5.

- [ ] **Step 1: Write the failing tests**

Append to `test/extension.test.ts`:

```typescript
import { ANTHROPIC_WARNING } from "../src/index.js";

describe("anthropic warning", () => {
  const warnCtx = (over: Parameters<typeof makeFakeCtx>[0] = {}) =>
    makeFakeCtx({
      cwd: agentDir, // harmless cwd; settings read targets PI_CODING_AGENT_DIR settings.json
      authStatus: new Map([["anthropic@work", true]]),
      ...over,
    });
  const model = { provider: "anthropic@work", id: "claude-x" };
  const setup = async () => {
    await seed([work]);
    const fake = makeFakePi();
    await extension(fake.pi);
    return fake;
  };

  it("warns once per process on select, with the exact spec text", async () => {
    const fake = await setup();
    const { ctx, notifications } = warnCtx();
    await fake.emit("model_select", { model, source: "set" }, ctx);
    await fake.emit("model_select", { model, source: "set" }, ctx);
    const warnings = notifications.filter((n) => n.message === ANTHROPIC_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("warning");
  });

  it("also warns on session restore", async () => {
    const fake = await setup();
    const { ctx, notifications } = warnCtx();
    await fake.emit("model_select", { model, source: "restore" }, ctx);
    expect(notifications.some((n) => n.message === ANTHROPIC_WARNING)).toBe(true);
  });

  it("ignores non-alias, non-anthropic, unauthenticated, and non-TUI selections", async () => {
    const fake = await setup();
    for (const [m, over] of [
      [{ provider: "anthropic", id: "claude-x" }, {}],                         // native provider
      [{ provider: "openai-codex@work", id: "gpt" }, {}],                      // wrong provider family
      [model, { authStatus: new Map([["anthropic@work", false]]) }],           // not authenticated
      [model, { mode: "rpc" }],                                                // not TUI
    ] as const) {
      const { ctx, notifications } = warnCtx(over as never);
      await fake.emit("model_select", { model: m, source: "set" }, ctx);
      expect(notifications).toHaveLength(0);
    }
  });

  it("suppresses when warnings.anthropicExtraUsage is explicitly false in merged settings", async () => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ warnings: { anthropicExtraUsage: false } }),
      "utf8",
    );
    const fake = await setup();
    const { ctx, notifications } = warnCtx();
    await fake.emit("model_select", { model, source: "set" }, ctx);
    expect(notifications).toHaveLength(0);
  });

  it("treats a settings read failure as warning enabled", async () => {
    await writeFile(join(agentDir, "settings.json"), "{corrupt", "utf8");
    const fake = await setup();
    const { ctx, notifications } = warnCtx();
    await fake.emit("model_select", { model, source: "set" }, ctx);
    expect(notifications.some((n) => n.message === ANTHROPIC_WARNING)).toBe(true);
  });
});
```

Note: `SettingsManager.create(cwd, agentDir?)` defaults its global settings path to `getAgentDir()`, which the test redirects via `PI_CODING_AGENT_DIR`, so writing `<agentDir>/settings.json` exercises the real merged-settings read with zero doubles. If `SettingsManager` swallows corrupt JSON instead of throwing (check `tryLoadFromStorage`), the "read failure" test still passes — enabled is the default either way; keep the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL — no `model_select` handler registered.

- [ ] **Step 3: Add the handler to `src/index.ts`** (inside the default export, after the `session_start` handler)

```typescript
  // Spec §8: once-per-process extra-usage warning for authenticated anthropic aliases (TUI only).
  pi.on("model_select", (event, ctx) => {
    if (warned || ctx.mode !== "tui") return;
    const account = accounts.find(
      (a) => a.provider === "anthropic" && aliasId(a) === event.model.provider,
    );
    if (!account) return;
    if (authStatusOf(ctx, event.model.provider) !== "authenticated") return;
    let enabled = true;
    try {
      const settings = SettingsManager.create(ctx.cwd, undefined, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      enabled = settings.getWarnings().anthropicExtraUsage !== false;
    } catch {
      enabled = true; // failure to read the setting = warning enabled (spec §8)
    }
    if (!enabled) return;
    warned = true;
    ctx.ui.notify(ANTHROPIC_WARNING, "warning");
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS / clean.

- [ ] **Step 5: Smoke-test in a live pi** (manual, no OAuth needed)

Run: `pi -e ./src/index.ts` then `/account`, `/account add work` (pick Anthropic), confirm the editor shows `/login anthropic@work`, check `~/.pi/agent/pi-account-manager/accounts.json`, `/account remove work`, `/account list`.
Expected: behavior matches spec §3; `/login` selector shows "Anthropic (work)".

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat: once-per-process Anthropic extra-usage warning with settings opt-out"
```

---

## Self-Review (performed while writing)

- **Spec coverage:** §1 scope → PROVIDERS table + no other commands touched; §2 → Task 1; §3 usage/TUI-only → Tasks 5–6; §3.1 → Tasks 5–6 (snapshot-only reads: `list` never rereads disk); §3.2 → Task 7; §3.3 → Task 8; §4.1/4.2 → OAuth-only alias participates in native login/logout automatically (Task 4), add prepares but never submits `/login` (Task 7); §4.3 → aliases are ordinary providers, `/model` untouched, unauthenticated alias models unavailable because OAuth-only auth resolves to unconfigured; §5 → Task 4 (attribution via `Model.provider` remap; catalog changes appear after reload because factory re-runs and `getModels()` delegates live); §6 → Tasks 3, 5 (two-phase all-or-none, load-error mode, per-process snapshot, 5 s lock, atomic rename, `/reload` abort); external-delete/re-add semantics need no code: credentials live under the alias id in pi's auth store, so a recreated alias with the same id sees them; §7 → no code partitions sessions; removal only unregisters a provider (pi keeps history readable — nothing to implement, deliberately); §8 → Task 9; §9 → each bullet maps to the listed test files; no live OAuth/network anywhere (bundled factories are used only for construction, never streamed through).
- **Placeholder scan:** the only stubs are `add`/`remove` in Task 5, explicitly replaced by Tasks 7–8 with full code. No TBDs.
- **Type consistency:** `Account`, `aliasId`, `mutateAccounts(file, snapshot, change)`, `makeAlias(base, account)`, `authStatusOf` names match across all tasks and tests.

Known deliberate simplifications (ponytail):

- Lockfile is `O_EXCL` + mtime staleness, not fcntl — fine for "two pi processes on one machine"; upgrade path is `proper-lockfile` if contention ever matters.
- List output is one `notify` block, not a TUI table component — spec only demands the fields and order.
- Rollback after a failed register/unregister is best-effort; disk is authoritative and the next factory run reconciles.
