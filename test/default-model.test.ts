import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptNativeDefaultModel } from "../src/default-model.ts";
import { cleanupAgentDir, harness, makeAgentDir, writeStateFile } from "./helpers.ts";

/** The same internal map pi reads when auto-selecting a model after /login. */
const piDefaultModelMap = async (): Promise<Record<string, string>> => {
	const specifier = pathToFileURL(join(getPackageDir(), "dist", "core", "model-resolver.js")).href;
	const module = (await import(specifier)) as { defaultModelPerProvider: Record<string, string> };
	return module.defaultModelPerProvider;
};

let agentDir: string;
const touched: string[] = [];

beforeEach(async () => {
	agentDir = await makeAgentDir();
});

afterEach(async () => {
	const map = await piDefaultModelMap();
	for (const id of touched.splice(0)) delete map[id];
	await cleanupAgentDir(agentDir);
});

const track = (id: string) => {
	touched.push(id);
	return id;
};

describe("adoptNativeDefaultModel", () => {
	it("reaches pi's real map and inherits the native provider's default", async () => {
		const map = await piDefaultModelMap();
		expect(map.anthropic).toBeTruthy();

		await adoptNativeDefaultModel("anthropic", track("anthropic@work"));
		expect(map["anthropic@work"]).toBe(map.anthropic);
	});

	it("covers both supported providers", async () => {
		const map = await piDefaultModelMap();
		await adoptNativeDefaultModel("anthropic", track("anthropic@a"));
		await adoptNativeDefaultModel("openai-codex", track("openai-codex@b"));
		expect(map["anthropic@a"]).toBe(map.anthropic);
		expect(map["openai-codex@b"]).toBe(map["openai-codex"]);
	});

	it("satisfies pi's own hasDefaultModelProvider check", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@gate");
		expect(id in map).toBe(false);
		await adoptNativeDefaultModel("anthropic", id);
		// This `in` test is exactly what pi gates the post-login selection on.
		expect(id in map).toBe(true);
	});

	it("inherits a model the alias actually offers, so pi can select it", async () => {
		const map = await piDefaultModelMap();
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [
				{ provider: "anthropic", name: "work" },
				{ provider: "openai-codex", name: "personal" },
			],
		});
		const pi = await harness(agentDir);
		track("anthropic@work");
		track("openai-codex@personal");

		for (const [aliasId, native] of [
			["anthropic@work", "anthropic"],
			["openai-codex@personal", "openai-codex"],
		]) {
			const wanted = map[native];
			const offered = pi.registry.getAll().filter((model) => model.provider === aliasId);
			expect(offered.some((model) => model.id === wanted), `${aliasId} offers ${wanted}`).toBe(true);
		}
	});

	it("never clobbers an existing entry", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@pinned");
		map[id] = "already-chosen";
		await adoptNativeDefaultModel("anthropic", id);
		expect(map[id]).toBe("already-chosen");
	});

	it("is applied to every account at load", async () => {
		const map = await piDefaultModelMap();
		await writeStateFile(agentDir, {
			version: 1,
			accounts: [
				{ provider: "anthropic", name: "one" },
				{ provider: "openai-codex", name: "two" },
			],
		});
		await harness(agentDir);
		track("anthropic@one");
		track("openai-codex@two");
		expect(map["anthropic@one"]).toBe(map.anthropic);
		expect(map["openai-codex@two"]).toBe(map["openai-codex"]);
	});

	it("leaves no entry behind when loading fails", async () => {
		const map = await piDefaultModelMap();
		await writeStateFile(agentDir, "{ broken");
		await harness(agentDir);
		expect("anthropic@work" in map).toBe(false);
	});
});
