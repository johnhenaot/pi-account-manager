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

const MODELS_JSON_MODEL = "gpt-6.2-sol";
const CATALOG_MODEL = "gpt-6-cyber";
const ALIAS = "openai@second";
const newerThanBundledModels = (getBuiltinModelDataGeneratedAt() ?? 0) + 1;

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
							id: MODELS_JSON_MODEL,
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
						id: CATALOG_MODEL,
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
				lastModified: newerThanBundledModels,
			},
		}),
	);
});
afterEach(() => cleanupAgentDir(agentDir));

async function startPiUpToFlagResolution() {
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
		const runtime = await startPiUpToFlagResolution();
		const ids = runtime.getModels("openai").map((model) => model.id);
		expect(ids).toContain(MODELS_JSON_MODEL);
		expect(ids).toContain(CATALOG_MODEL);
	});

	it.each([MODELS_JSON_MODEL, CATALOG_MODEL])("--list-models shows %s under the alias", async (id) => {
		const runtime = await startPiUpToFlagResolution();
		const available = await runtime.getAvailable(ALIAS);
		expect(available.map((model) => model.id)).toContain(id);
	});

	it.each([MODELS_JSON_MODEL, CATALOG_MODEL])("--model resolves %s under the alias without a warning", async (id) => {
		const runtime = await startPiUpToFlagResolution();
		const resolved = resolveCliModel({ cliModel: `${ALIAS}/${id}`, modelRuntime: runtime });
		expect(resolved.warning).toBeUndefined();
		expect(resolved.error).toBeUndefined();
		expect(resolved.model).toMatchObject({ id, provider: ALIAS });
	});

	it.each([MODELS_JSON_MODEL, CATALOG_MODEL])("--thinking max stays max on %s under the alias", async (id) => {
		const runtime = await startPiUpToFlagResolution();
		const { model } = resolveCliModel({ cliModel: `${ALIAS}/${id}`, cliThinking: "max", modelRuntime: runtime });
		expect(clampThinkingLevel(model!, "max")).toBe("max");
		expect(clampThinkingLevel(model!, "xhigh")).toBe("xhigh");
	});
});

describe("startup provider rebuild", () => {
	it("reads pi's files without writing them or touching credentials", async () => {
		const before = await readFile(join(agentDir, "models-store.json"), "utf8");
		await startPiUpToFlagResolution();
		expect(await readFile(join(agentDir, "models-store.json"), "utf8")).toBe(before);
		await expect(readFile(join(agentDir, "auth.json"), "utf8")).rejects.toThrow();
	});

	it("falls back to the bundled models when models.json is broken", async () => {
		await writeFile(join(agentDir, "models.json"), "{ broken");
		const runtime = await startPiUpToFlagResolution();
		const ids = runtime.getModels(ALIAS).map((model) => model.id);
		expect(ids).toContain("gpt-6.1-sol");
		expect(ids).not.toContain(MODELS_JSON_MODEL);
	});

	it("keeps models.json models when the catalog cache is broken", async () => {
		await writeFile(join(agentDir, "models-store.json"), "{ broken");
		const ids = (await startupProviders(agentDir, ["openai"]))
			.get("openai")
			?.getModels()
			.map((model) => model.id);
		expect(ids).toContain(MODELS_JSON_MODEL);
		expect(ids).not.toContain(CATALOG_MODEL);
	});
});
