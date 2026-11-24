import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/account.ts";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import { isAuthenticated } from "../src/index.ts";
import { cleanupAgentDir, makeAgentDir, oauthCredential, realRegistry, stubProvider } from "./helpers.ts";

let agentDir: string;

beforeEach(async () => {
	agentDir = await makeAgentDir();
});

afterEach(async () => {
	await cleanupAgentDir(agentDir);
});

const work: Account = { provider: "anthropic", name: "work" };

describe("buildAlias", () => {
	it("builds from pi's exact bundled factory", () => {
		const base = bundledProvider("anthropic");
		expect(base?.id).toBe("anthropic");
		const alias = buildAlias(base, work);
		expect(alias.id).toBe("anthropic@work");
		expect(alias.name).toBe("Anthropic (work)");
		expect(alias.baseUrl).toBe(base?.baseUrl);
	});

	it("builds from all supported bundled providers", () => {
		for (const provider of ["anthropic", "openai", "openai-codex"] as const) {
			const alias = buildAlias(bundledProvider(provider), { provider, name: "personal" });
			expect(alias.id).toBe(`${provider}@personal`);
			expect(alias.getModels().length).toBeGreaterThan(0);
		}
	});

	it("exposes OAuth only, dropping the native provider's API key path", () => {
		const base = bundledProvider("anthropic")!;
		expect(base.auth.apiKey).toBeDefined();
		const alias = buildAlias(base, work);
		expect(alias.auth.oauth).toBe(base.auth.oauth);
		expect(alias.auth.apiKey).toBeUndefined();
	});

	it("mirrors the native catalog with the alias ID as provider", () => {
		const base = bundledProvider("anthropic")!;
		const native = base.getModels();
		const aliased = buildAlias(base, work).getModels();
		expect(aliased.map((m) => m.id)).toEqual(native.map((m) => m.id));
		expect(new Set(aliased.map((m) => m.provider))).toEqual(new Set(["anthropic@work"]));
		for (const [index, model] of aliased.entries()) {
			expect({ ...model, provider: "anthropic" }).toEqual(native[index]);
		}
	});

	it("tracks a native catalog change without being rebuilt", () => {
		let models = stubProvider("anthropic").getModels();
		const base: Provider = { ...stubProvider("anthropic"), getModels: () => models };
		const alias = buildAlias(base, work);
		expect(alias.getModels()).toHaveLength(2);
		models = models.slice(0, 1);
		expect(alias.getModels()).toHaveLength(1);
	});

	it("attributes the stream to the alias and delegates to the native provider", async () => {
		const alias = buildAlias(stubProvider("anthropic"), work);
		const model = alias.getModels()[0];
		const message = await alias.streamSimple(model, normalizeContext({ messages: [] })).result();
		expect(message.provider).toBe("anthropic@work");
		expect(message.model).toBe(model.id);
	});

	it("preserves a native model filter across the provider remap", () => {
		const base: Provider = {
			...stubProvider("anthropic"),
			filterModels: (models) => models.filter((model) => model.id === "model-1" && model.provider === "anthropic"),
		};
		const alias = buildAlias(base, work);
		const kept = alias.filterModels!(alias.getModels(), undefined);
		expect(kept.map((model) => model.id)).toEqual(["model-1"]);
		expect(kept.map((model) => model.provider)).toEqual(["anthropic@work"]);
	});

	it("refuses a base that cannot back an alias", () => {
		expect(() => buildAlias(undefined, work)).toThrow("no OAuth flow");
		expect(() => buildAlias(stubProvider("anthropic", { oauth: false }), work)).toThrow("no OAuth flow");
	});
});

describe("pi registry contract", () => {
	it("registers an alias alongside the native provider it wraps", async () => {
		const { registry } = await realRegistry(agentDir);
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		expect(registry.getProvider("anthropic@work")?.name).toBe("Anthropic (work)");
		expect(registry.getProvider("anthropic")?.id).toBe("anthropic");
		expect(registry.getRegisteredProviderIds()).toContain("anthropic@work");
	});

	it("mirrors the effective provider's models under the alias ID", async () => {
		const { registry } = await realRegistry(agentDir);
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		const native = registry.getAll().filter((model) => model.provider === "anthropic");
		const aliased = registry.getAll().filter((model) => model.provider === "anthropic@work");
		expect(aliased.map((m) => m.id)).toEqual(native.map((m) => m.id));
		expect(aliased.map((m) => [m.name, m.contextWindow, m.maxTokens, m.cost])).toEqual(
			native.map((m) => [m.name, m.contextWindow, m.maxTokens, m.cost]),
		);
	});

	it("gates alias model availability on an alias-scoped OAuth credential", async () => {
		const { credentials, runtime, registry } = await realRegistry(agentDir);
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(false);
		expect((await runtime.getAvailable()).some((m) => m.provider === "anthropic@work")).toBe(false);
		expect(isAuthenticated(registry, "anthropic@work")).toBe(false);

		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);
		expect(runtime.isUsingOAuth("anthropic@work")).toBe(true);
		expect((await runtime.getAvailable()).some((m) => m.provider === "anthropic@work")).toBe(true);
		expect(isAuthenticated(registry, "anthropic@work")).toBe(true);
	});

	it("keeps credentials isolated per alias", async () => {
		const { credentials, runtime, registry } = await realRegistry(agentDir);
		for (const name of ["work", "personal"]) {
			registry.registerProvider(buildAlias(registry.getProvider("anthropic"), { provider: "anthropic", name }));
		}
		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);
		expect(runtime.getProviderAuthStatus("anthropic@personal").configured).toBe(false);
		expect(credentials.entries.has("anthropic")).toBe(false);
	});

	it("follows the headers models.json sets on the native provider, the documented exception to isolation", async () => {
		const modelsPath = join(agentDir, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { anthropic: { headers: { "x-fake-team": "blue" } } } }));
		const { credentials, runtime, registry } = await realRegistry(agentDir, modelsPath);
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		await credentials.modify("anthropic@work", async () => oauthCredential());
		expect((await runtime.getAuth("anthropic@work"))?.auth.headers).toMatchObject({ "x-fake-team": "blue" });
	});

	it("leaves the account registered but unauthenticated after logout", async () => {
		const { credentials, runtime, registry } = await realRegistry(agentDir);
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		await credentials.modify("anthropic@work", async () => oauthCredential());
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(true);

		await runtime.logout("anthropic@work");
		expect(runtime.getProvider("anthropic@work")).toBeDefined();
		expect(runtime.getProviderAuthStatus("anthropic@work").configured).toBe(false);
		expect(runtime.getModels().some((m) => m.provider === "anthropic@work")).toBe(true);
	});

	it("offers /login only pi's own Anthropic OAuth flow, with no API key option", async () => {
		const { registry, runtime } = await realRegistry(agentDir);
		const native = registry.getProvider("anthropic")!;
		registry.registerProvider(buildAlias(native, work));
		await runtime.refresh({ allowNetwork: false });

		const alias = runtime.getProvider("anthropic@work")!;
		expect(alias.auth.apiKey).toBeUndefined();
		expect(alias.auth.oauth).toBe(native.auth.oauth);
		expect(alias.auth.oauth?.name).toBe("Anthropic (Claude Pro/Max)");
	});

	it("unregisters cleanly, leaving the native provider usable", async () => {
		const { runtime, registry } = await realRegistry(agentDir);
		const nativeModelCount = registry.getAll().filter((m) => m.provider === "anthropic").length;
		registry.registerProvider(buildAlias(registry.getProvider("anthropic"), work));
		registry.unregisterProvider("anthropic@work");
		expect(runtime.getProvider("anthropic@work")).toBeUndefined();
		expect(isAuthenticated(registry, "anthropic@work")).toBe(false);
		expect(registry.getAll().filter((m) => m.provider === "anthropic")).toHaveLength(nativeModelCount);
	});
});
