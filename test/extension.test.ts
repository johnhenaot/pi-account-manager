import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/account.ts";
import { USAGE } from "../src/command.ts";
import { ANTHROPIC_EXTRA_USAGE_WARNING, ANTHROPIC_WARNING_LATCH, authState } from "../src/index.ts";
import { EMPTY_LIST } from "../src/list.ts";
import { loadAccounts } from "../src/state.ts";
import {
	cleanupAgentDir,
	harness,
	type HarnessOptions,
	makeAgentDir,
	oauthCredential,
	readStateFile,
	stubProvider,
	writeStateFile,
} from "./helpers.ts";

let agentDir: string;

beforeEach(async () => {
	agentDir = await makeAgentDir();
	delete (globalThis as Record<symbol, unknown>)[ANTHROPIC_WARNING_LATCH];
});

afterEach(async () => {
	await cleanupAgentDir(agentDir);
});

const work: Account = { provider: "anthropic", name: "work" };

const start = (options: HarnessOptions = {}) => harness(agentDir, options);

describe("/account list", () => {
	it("reports an empty snapshot with the exact message", async () => {
		const pi = await start();
		await pi.account("");
		expect(pi.last()).toEqual({ message: EMPTY_LIST, type: "info" });
	});

	it("lists loaded accounts with name, provider, alias ID, and status", async () => {
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "openai-codex", name: "personal" }],
		});
		const pi = await start();
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });

		await pi.account("list");
		const text = pi.last().message;
		expect(text).toContain("anthropic@work");
		expect(text).toContain("Anthropic");
		expect(text).toContain("authenticated");
		expect(text).toContain("openai-codex@personal");
		expect(text).toContain("not authenticated");
	});

	it("shows the load error instead of rows, and still refuses changes", async () => {
		await writeStateFile(agentDir, "{ broken");
		const pi = await start();
		expect(pi.providers.size).toBe(0);

		await pi.account("");
		expect(pi.last().type).toBe("error");
		expect(pi.last().message).toContain("not valid JSON");

		await pi.account("add work");
		expect(pi.last().message).toContain("/reload");
		await pi.account("remove work");
		expect(pi.last().message).toContain("/reload");
	});

	it("changes nothing", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		const before = await readStateFile(agentDir);
		await pi.account("list");
		expect(await readStateFile(agentDir)).toBe(before);
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});

	it("uses the loaded snapshot instead of rereading persistent state", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();

		// Another process changes the file; this process keeps its snapshot until reload.
		await writeStateFile(agentDir, { version: 1, accounts: [{ provider: "openai-codex", name: "elsewhere" }] });
		await pi.account("list");
		expect(pi.last().message).toContain("anthropic@work");
		expect(pi.last().message).not.toContain("elsewhere");
	});
});

describe("/account usage", () => {
	it("shows usage and makes no state change", async () => {
		const pi = await start();
		await pi.account("bogus");
		expect(pi.last()).toEqual({ message: USAGE, type: "error" });
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});

	it("is interactive-only", async () => {
		const pi = await start();
		for (const mode of ["rpc", "json", "print"]) {
			pi.setMode(mode);
			await pi.account("add work");
			expect(pi.last().message).toContain("interactive mode only");
		}
		await expect(loadAccounts(agentDir)).resolves.toEqual([]);
	});
});

describe("/account add", () => {
	it("prompts for name and provider, persists, registers, and prefills /login", async () => {
		const pi = await start({ answers: ["  WORK ", "Anthropic"] });
		await pi.account("add");

		expect(await loadAccounts(agentDir)).toEqual([work]);
		expect(pi.registry.getProvider("anthropic@work")?.name).toBe("Anthropic (work)");
		expect(pi.editor()).toBe("/login anthropic@work");
	});

	it("preserves a non-empty editor and shows the exact command instead", async () => {
		const pi = await start({ editorText: "draft text", answers: ["OpenAI Codex"] });
		await pi.account("add personal");
		expect(pi.editor()).toBe("draft text");
		expect(pi.last().message).toContain("/login openai-codex@personal");
	});

	it("makes no state change when the name prompt is cancelled", async () => {
		const pi = await start({ answers: [undefined] });
		await pi.account("add");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.providers.size).toBe(0);
	});

	it("makes no state change when the provider prompt is cancelled", async () => {
		const pi = await start({ answers: [undefined] });
		await pi.account("add work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.providers.size).toBe(0);
	});

	it("rejects an invalid name before prompting for a provider", async () => {
		const pi = await start({ answers: ["Anthropic"] });
		await pi.account("add bad name");
		expect(pi.last()).toEqual({ message: USAGE, type: "error" });

		const pi2 = await start({ answers: ["-nope", "Anthropic"] });
		await pi2.account("add");
		expect(pi2.last().type).toBe("error");
		expect(pi2.last().message).toContain("Invalid account name");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("rejects an existing (provider, name) and points at /login", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start({ answers: ["Anthropic"] });
		await pi.account("add work");
		expect(pi.last().type).toBe("error");
		expect(pi.last().message).toBe("anthropic@work already exists. Use /login anthropic@work to reauthenticate it.");
	});

	it("allows the same name under the other provider", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start({ answers: ["OpenAI Codex"] });
		await pi.account("add work");
		expect((await loadAccounts(agentDir)).map((a) => `${a.provider}@${a.name}`)).toEqual([
			"anthropic@work",
			"openai-codex@work",
		]);
	});

	it("refuses when the alias ID is already owned by another provider", async () => {
		const pi = await start({ answers: ["Anthropic"] });
		pi.registry.registerProvider(stubProvider("anthropic@taken"));
		await pi.account("add taken");
		expect(pi.last().message).toContain("already in use");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("aborts with a /reload instruction when state drifted", async () => {
		const pi = await start({ answers: ["Anthropic"] });
		await writeStateFile(agentDir, { version: 1, accounts: [{ provider: "openai-codex", name: "other" }] });
		await pi.account("add work");
		expect(pi.last().message).toContain("/reload");
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
	});
});

describe("/account remove", () => {
	const seeded = async (accounts: Account[], options: HarnessOptions = {}) => {
		await writeStateFile(agentDir, { version: 1, accounts });
		const pi = await start(options);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });
		await pi.runtime.refresh({ allowNetwork: false });
		return pi;
	};

	it("removes an unauthenticated, inactive account and unregisters it", async () => {
		const pi = await seeded([work]);
		await pi.account("remove anthropic@work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(pi.last().type).toBe("info");
	});

	it("resolves a bare name to its single match", async () => {
		const pi = await seeded([work]);
		await pi.account("remove WORK");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("offers a selector for two name matches", async () => {
		const pi = await seeded([work, { provider: "openai-codex", name: "work" }], {
			answers: ["openai-codex@work"],
		});
		await pi.account("remove work");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("offers a selector when no argument is given", async () => {
		const pi = await seeded([work], { answers: ["anthropic@work"] });
		await pi.account("remove");
		expect(await loadAccounts(agentDir)).toEqual([]);
	});

	it("makes no state change when the selector is cancelled", async () => {
		const pi = await seeded([work], { answers: [undefined] });
		await pi.account("remove");
		expect(await loadAccounts(agentDir)).toEqual([work]);
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});

	it("makes no state change for invalid input or a miss", async () => {
		const pi = await seeded([work]);
		for (const argument of ["not a name", "missing", "Anthropic@work"]) {
			await pi.account(`remove ${argument}`);
			expect(pi.last().type, argument).toBe("error");
		}
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("refuses an authenticated account and instructs /logout", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/logout");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("refuses the active model's account and instructs /model", async () => {
		const pi = await seeded([work]);
		pi.setModel(pi.registry.getAll().find((model) => model.provider === "anthropic@work"));
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/model");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("shows both instructions when both apply", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });
		pi.setModel(pi.registry.getAll().find((model) => model.provider === "anthropic@work"));
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/logout");
		expect(pi.last().message).toContain("/model");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("fails closed when authentication status is unavailable", async () => {
		const pi = await seeded([work]);
		// Drop the alias out of the registry so pi can no longer report its status.
		pi.registry.unregisterProvider("anthropic@work");
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("status is unavailable");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});

	it("leaves the credential in place", async () => {
		const pi = await seeded([work]);
		await pi.credentials.modify("anthropic@other", async () => oauthCredential());
		await pi.account("remove anthropic@work");
		expect(await loadAccounts(agentDir)).toEqual([]);
		expect(pi.credentials.entries.has("anthropic@other")).toBe(true);
	});

	it("aborts with a /reload instruction when the target disappeared", async () => {
		const pi = await seeded([work]);
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		await pi.account("remove anthropic@work");
		expect(pi.last().message).toContain("/reload");
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();
	});
});

describe("loading lifecycle", () => {
	it("bootstraps every persisted account before any session starts", async () => {
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "openai-codex", name: "personal" }],
		});
		const pi = await start();
		expect([...pi.providers.keys()].sort()).toEqual(["anthropic@work", "openai-codex@personal"]);
	});

	it("replaces bootstrap aliases against the effective registry on session_start", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		const bootstrapped = pi.registry.getProvider("anthropic@work");
		await pi.emit("session_start", { type: "session_start", reason: "startup" });
		const replaced = pi.registry.getProvider("anthropic@work");
		expect(replaced).toBeDefined();
		expect(replaced).not.toBe(bootstrapped);
		expect(replaced?.name).toBe("Anthropic (work)");
	});

	it("loads no alias at all when one bootstrap registration fails", async () => {
		const accounts: Account[] = [
			work,
			{ provider: "anthropic", name: "second" },
			{ provider: "openai-codex", name: "third" },
		];
		await writeStateFile(agentDir, { version: 1, accounts });

		const ok = await start();
		expect([...ok.providers.keys()]).toHaveLength(3);

		// The third registration fails, so the first two must be rolled back.
		const failed = await start({ rejectProviderId: "openai-codex@third" });
		expect([...failed.providers.keys()]).toEqual([]);
		expect(failed.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(failed.registry.getProvider("anthropic@second")).toBeUndefined();
		// Native providers stay usable, and /account still reports the failure.
		expect(failed.registry.getProvider("anthropic")?.id).toBe("anthropic");
		await failed.account("");
		expect(failed.last().type).toBe("error");
		expect(failed.last().message).toContain("rejected openai-codex@third");
	});

	it("keeps no alias loaded when the session_start replacement fails", async () => {
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "openai-codex", name: "personal" }],
		});
		const pi = await start();
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();

		pi.rejectProvider("openai-codex@personal");
		await pi.emit("session_start", { type: "session_start", reason: "reload" });

		// Neither the replacement nor the bootstrap alias may survive.
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(pi.registry.getProvider("openai-codex@personal")).toBeUndefined();
		expect(pi.registry.getProvider("anthropic")?.id).toBe("anthropic");

		await pi.account("");
		expect(pi.last().type).toBe("error");
		await pi.account("add other");
		expect(pi.last().message).toContain("/reload");
	});

	it("keeps native providers usable when loading fails", async () => {
		await writeStateFile(agentDir, "{ broken");
		const pi = await start();
		expect(pi.providers.size).toBe(0);
		expect(pi.registry.getProvider("anthropic")?.id).toBe("anthropic");
		expect(pi.registry.getAll().some((model) => model.provider === "anthropic")).toBe(true);
	});

	it("recreates the same alias when the same pair is re-added", async () => {
		const pi = await start({ answers: ["Anthropic"] });
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.account("add work");
		await pi.runtime.refresh({ allowNetwork: false });
		// An externally kept credential makes the re-added account immediately authenticated.
		expect(authState(pi.registry, "anthropic@work")).toBe("authenticated");
	});
});

describe("anthropic extra-usage warning", () => {
	const clearLatch = () => {
		delete (globalThis as Record<symbol, unknown>)[ANTHROPIC_WARNING_LATCH];
	};

	const authenticated = async (settings?: unknown) => {
		if (settings !== undefined) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "openai-codex", name: "personal" }],
		});
		const pi = await start();
		await pi.emit("session_start", { type: "session_start", reason: "startup" });
		for (const id of ["anthropic@work", "openai-codex@personal"]) {
			await pi.credentials.modify(id, async () => oauthCredential());
		}
		await pi.runtime.refresh({ allowNetwork: false });
		return pi;
	};

	const modelOf = (pi: Awaited<ReturnType<typeof harness>>, provider: string) =>
		pi.registry.getAll().find((model) => model.provider === provider);

	const select = (pi: Awaited<ReturnType<typeof harness>>, provider: string, source = "set") =>
		pi.emit("model_select", { type: "model_select", source, model: modelOf(pi, provider) });

	it("warns once per process with the exact text", async () => {
		const pi = await authenticated();
		select(pi, "anthropic@work");
		expect(pi.last()).toEqual({ message: ANTHROPIC_EXTRA_USAGE_WARNING, type: "warning" });
		const count = pi.notifications.length;
		select(pi, "anthropic@work");
		select(pi, "anthropic@work", "cycle");
		expect(pi.notifications).toHaveLength(count);
	});

	/**
	 * Pi never emits model_select for a restored session, so the warning has to come from
	 * session_start reading ctx.model. Asserting a synthetic source: "restore" event would
	 * only test the mock.
	 */
	it("warns for a session restored onto an alias model", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		await pi.credentials.modify("anthropic@work", async () => oauthCredential());
		await pi.runtime.refresh({ allowNetwork: false });

		pi.setModel(modelOf(pi, "anthropic@work"));
		await pi.emit("session_start", { type: "session_start", reason: "resume" });
		expect(pi.last()).toEqual({ message: ANTHROPIC_EXTRA_USAGE_WARNING, type: "warning" });
	});

	it("stays quiet on restore for an unauthenticated or native model", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		await pi.runtime.refresh({ allowNetwork: false });

		pi.setModel(modelOf(pi, "anthropic@work"));
		await pi.emit("session_start", { type: "session_start", reason: "resume" });
		expect(pi.notifications).toHaveLength(0);

		pi.setModel(pi.registry.getAll().find((model) => model.provider === "anthropic"));
		await pi.emit("session_start", { type: "session_start", reason: "resume" });
		expect(pi.notifications).toHaveLength(0);
	});

	it("stays latched across a reload in the same process", async () => {
		const first = await authenticated();
		select(first, "anthropic@work");
		expect(first.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);

		// /reload re-runs the factory; the latch must outlive the closure.
		const second = await start();
		await second.credentials.modify("anthropic@work", async () => oauthCredential());
		await second.runtime.refresh({ allowNetwork: false });
		select(second, "anthropic@work");
		expect(second.notifications).toHaveLength(0);
	});

	it("stays quiet for other providers and for unauthenticated aliases", async () => {
		const pi = await authenticated();
		select(pi, "openai-codex@personal");
		select(pi, "anthropic");
		expect(pi.notifications).toHaveLength(0);

		await pi.runtime.logout("anthropic@work");
		select(pi, "anthropic@work");
		expect(pi.notifications).toHaveLength(0);
	});

	it("is suppressed only by an explicit false", async () => {
		const off = await authenticated({ warnings: { anthropicExtraUsage: false } });
		select(off, "anthropic@work");
		expect(off.notifications).toHaveLength(0);

		clearLatch();
		const on = await authenticated({ warnings: { anthropicExtraUsage: true } });
		select(on, "anthropic@work");
		expect(on.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);

		clearLatch();
		const unset = await authenticated({ warnings: {} });
		select(unset, "anthropic@work");
		expect(unset.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);
	});

	it("warns when the setting cannot be read, and never blocks model use", async () => {
		const pi = await authenticated("not json at all");
		expect(() => select(pi, "anthropic@work")).not.toThrow();
		expect(pi.last().message).toBe(ANTHROPIC_EXTRA_USAGE_WARNING);
	});

	it("stays quiet outside interactive mode", async () => {
		const pi = await authenticated();
		pi.setMode("rpc");
		select(pi, "anthropic@work");
		expect(pi.notifications).toHaveLength(0);
	});
});

describe("reload cleanup", () => {
	it("unregisters this instance's aliases on session_shutdown for a reload", async () => {
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [work, { provider: "openai-codex", name: "personal" }],
		});
		const pi = await start();
		expect(pi.registry.getProvider("anthropic@work")).toBeDefined();

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		expect(pi.registry.getProvider("anthropic@work")).toBeUndefined();
		expect(pi.registry.getProvider("openai-codex@personal")).toBeUndefined();
		// Native providers are untouched.
		expect(pi.registry.getProvider("anthropic")?.id).toBe("anthropic");
	});

	it("keeps aliases registered for shutdown reasons that reuse the extension", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		for (const reason of ["quit", "new", "resume", "fork"]) {
			await pi.emit("session_shutdown", { type: "session_shutdown", reason });
			expect(pi.registry.getProvider("anthropic@work"), reason).toBeDefined();
		}
	});

	it("lets a removed account's name be re-added after a reload", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const first = await start();
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

		// Another process removed the account; this process reloads into the new state.
		await writeStateFile(agentDir, { version: 1, accounts: [] });
		const second = await harness(agentDir, { answers: ["Anthropic"] });
		await second.emit("session_start", { type: "session_start", reason: "reload" });

		await second.account("add work");
		expect(second.last().type).toBe("info");
		expect(await loadAccounts(agentDir)).toEqual([work]);
	});
});

describe("provider ID ownership at session_start", () => {
	it("refuses to take over an alias ID owned by someone else", async () => {
		await writeStateFile(agentDir, { version: 1, accounts: [work] });
		const pi = await start();
		// Simulate a reloaded instance whose ID is held by a foreign provider.
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		pi.registry.registerProvider(stubProvider("anthropic@work"));

		await pi.emit("session_start", { type: "session_start", reason: "reload" });
		expect(pi.registry.getProvider("anthropic@work")?.name).toBe("anthropic@work");
		await pi.account("");
		expect(pi.last().type).toBe("error");
		expect(pi.last().message).toContain("already in use");
	});
});
