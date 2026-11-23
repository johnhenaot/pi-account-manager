import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clampThinkingLevel, type Provider } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startupProviders } from "../src/alias.ts";
import createAccountManager from "../src/index.ts";
import { cleanupAgentDir, makeAgentDir, memoryCredentials, oauthCredential, writeStateFile } from "./helpers.ts";

const LOCAL = "fixture-config-chat";
const CACHED = "fixture-catalog-chat";
const ALIAS = "openai@second";
const base = getBuiltinModels("openai")[0];
const reasoning = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };

let agentDir: string;
beforeEach(async () => {
	agentDir = await makeAgentDir();
	await writeStateFile(agentDir, { version: 1, accounts: [{ provider: "openai", name: "second" }] });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { openai: { models: [{ id: LOCAL, api: "openai-responses", ...reasoning }] } } }),
	);
	await writeFile(
		join(agentDir, "models-store.json"),
		JSON.stringify({
			openai: {
				models: [{ ...base, id: CACHED, ...reasoning }],
				lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
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

it("lists and resolves both alias models with max thinking before session_start", async () => {
	const runtime = await startPiUpToFlagResolution();
	const available = (await runtime.getAvailable(ALIAS)).map((model) => model.id);
	for (const id of [LOCAL, CACHED]) {
		expect(available).toContain(id);
		const result = resolveCliModel({ cliModel: `${ALIAS}/${id}`, cliThinking: "max", modelRuntime: runtime });
		expect(result.warning).toBeUndefined();
		expect(result.model).toMatchObject({ id, provider: ALIAS });
		expect(clampThinkingLevel(result.model!, "max")).toBe("max");
		expect(clampThinkingLevel(result.model!, "xhigh")).toBe("xhigh");
	}
});

it.each([
	["models.json", CACHED, LOCAL],
	["models-store.json", LOCAL, CACHED],
])("a broken %s leaves the other source intact", async (file, kept, absent) => {
	await writeFile(join(agentDir, file), "{ broken");
	const models = await startupProviders(agentDir, ["openai"]);
	const ids = models?.getModels("openai").map((model) => model.id);
	expect(ids).toContain(kept);
	expect(ids).toContain(base.id);
	expect(ids).not.toContain(absent);
});

it("restores a BOM-prefixed cache without changing it or creating auth.json", async () => {
	const path = join(agentDir, "models-store.json");
	const bom = `\uFEFF${await readFile(path, "utf8")}`;
	await writeFile(path, bom);
	const models = await startupProviders(agentDir, ["openai"]);
	expect(models?.getModel("openai", CACHED)).toBeDefined();
	expect(await readFile(path, "utf8")).toBe(bom);
	await expect(readFile(join(agentDir, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
