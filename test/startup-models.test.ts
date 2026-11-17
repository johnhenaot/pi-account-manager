import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startupProviders } from "../src/alias.ts";
import createAccountManager from "../src/index.ts";
import { cleanupAgentDir, makeAgentDir, memoryCredentials, oauthCredential, writeStateFile } from "./helpers.ts";

// A model only models.json defines, and one only the cached pi.dev catalog defines.
const CUSTOM = "gpt-6.2-sol";
const CATALOG = "gpt-6-cyber";
const ALIAS = "openai@second";

let agentDir: string;
beforeEach(async () => {
	agentDir = await makeAgentDir();
	await writeStateFile(agentDir, { version: 1, accounts: [{ provider: "openai", name: "second" }] });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				openai: {
					models: [
						{
							id: CUSTOM,
							name: "GPT-6.2 Sol",
							api: "openai-responses",
							reasoning: true,
							thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "models-store.json"),
		JSON.stringify({
			openai: {
				models: [
					{
						id: CATALOG,
						name: "GPT-6 Cyber",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://api.openai.com/v1",
						reasoning: true,
						input: ["text"],
						cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 272000,
						maxTokens: 128000,
						thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
						type: "chat",
					},
				],
				checkedAt: Date.now(),
				// Newer than the bundle, or pi ignores the cached catalog.
				lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
			},
		}),
	);
});
afterEach(() => cleanupAgentDir(agentDir));

/**
 * Pi's startup order: the runtime is created, extensions load, their providers are registered,
 * the runtime refreshes offline, and only then are --model, --thinking and --list-models resolved.
 * session_start comes later, so no session handler runs here.
 */
async function startPi() {
	const credentials = memoryCredentials();
	await credentials.modify(ALIAS, async () => oauthCredential());
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const pending: Provider[] = [];
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerProvider: (provider: Provider) => pending.push(provider),
		unregisterProvider: () => {},
	};
	await createAccountManager(pi as never);
	for (const provider of pending) runtime.registerNativeProvider(provider);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("models outside pi's bundle, before session_start", () => {
	it("the native provider has both (sanity check of the fixture)", async () => {
		const runtime = await startPi();
		const ids = runtime.getModels("openai").map((model) => model.id);
		expect(ids).toContain(CUSTOM);
		expect(ids).toContain(CATALOG);
	});

	it.each([CUSTOM, CATALOG])("--list-models shows %s under the alias", async (id) => {
		const runtime = await startPi();
		const available = await runtime.getAvailable(ALIAS);
		expect(available.map((model) => model.id)).toContain(id);
	});

	it.each([CUSTOM, CATALOG])("--model resolves %s under the alias without a warning", async (id) => {
		const runtime = await startPi();
		const resolved = resolveCliModel({ cliModel: `${ALIAS}/${id}`, modelRuntime: runtime });
		expect(resolved.warning).toBeUndefined();
		expect(resolved.error).toBeUndefined();
		expect(resolved.model).toMatchObject({ id, provider: ALIAS });
	});

	it.each([CUSTOM, CATALOG])("--thinking max stays max on %s under the alias", async (id) => {
		const runtime = await startPi();
		const { model } = resolveCliModel({ cliModel: `${ALIAS}/${id}`, cliThinking: "max", modelRuntime: runtime });
		expect(clampThinkingLevel(model!, "max")).toBe("max");
		expect(clampThinkingLevel(model!, "xhigh")).toBe("xhigh");
	});
});

describe("startup provider rebuild", () => {
	it("reads pi's files without writing them or touching credentials", async () => {
		const before = await readFile(join(agentDir, "models-store.json"), "utf8");
		await startPi();
		expect(await readFile(join(agentDir, "models-store.json"), "utf8")).toBe(before);
		await expect(readFile(join(agentDir, "auth.json"), "utf8")).rejects.toThrow();
	});

	it("falls back to the bundled models when models.json is broken", async () => {
		await writeFile(join(agentDir, "models.json"), "{ broken");
		const runtime = await startPi();
		const ids = runtime.getModels(ALIAS).map((model) => model.id);
		expect(ids).toContain("gpt-6.1-sol");
		expect(ids).not.toContain(CUSTOM);
	});

	it("keeps models.json models when the catalog cache is broken", async () => {
		await writeFile(join(agentDir, "models-store.json"), "{ broken");
		const ids = (await startupProviders(agentDir, ["openai"]))
			.get("openai")
			?.getModels()
			.map((model) => model.id);
		expect(ids).toContain(CUSTOM);
		expect(ids).not.toContain(CATALOG);
	});
});
