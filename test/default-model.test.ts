import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptNativeDefaultModel, modelResolverSpecifier, releaseDefaultModel } from "../src/default-model.ts";
import { cleanupAgentDir, harness, makeAgentDir, writeStateFile } from "./helpers.ts";

const run = promisify(execFile);

/** The same internal map pi reads when auto-selecting a model after /login. */
const piDefaultModelMap = async (): Promise<Record<string, string>> => {
	const module = (await import(modelResolverSpecifier())) as { defaultModelPerProvider: Record<string, string> };
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

const aliasOffering = (id: string, modelIds: string[]): Provider =>
	({ id, getModels: () => modelIds.map((modelId) => ({ id: modelId })) }) as unknown as Provider;

/** An alias whose catalog contains its native provider's default, the normal case. */
const nativeAlias = async (provider: string, id: string): Promise<Provider> =>
	aliasOffering(id, [(await piDefaultModelMap())[provider]]);

const track = (id: string) => {
	touched.push(id);
	return id;
};

describe("adoptNativeDefaultModel", () => {
	it("resolves to a model-resolver module and reaches pi's real map", async () => {
		const specifier = modelResolverSpecifier();
		expect(specifier.startsWith("file://")).toBe(true);
		expect(specifier.endsWith("/dist/core/model-resolver.js")).toBe(true);
		await expect(piDefaultModelMap()).resolves.toMatchObject({ anthropic: expect.any(String) });
	});

	it("derives the specifier from the module graph, never from the environment", async () => {
		// getPackageDir() honours $PI_PACKAGE_DIR verbatim, and this string becomes an
		// executable module specifier — so the resolved path must not follow the env.
		// Pi always has import.meta.resolve, so this branch is the one it takes.
		const resolve = () => "file:///real/pi/dist/index.js";
		const before = modelResolverSpecifier(resolve);
		process.env.PI_PACKAGE_DIR = "/attacker-controlled";
		try {
			expect(modelResolverSpecifier(resolve)).toBe(before);
			expect(before).toBe("file:///real/pi/dist/core/model-resolver.js");
		} finally {
			delete process.env.PI_PACKAGE_DIR;
		}
	});

	it("falls back to the package directory when the runtime has no resolver", () => {
		expect(modelResolverSpecifier(undefined).endsWith("/dist/core/model-resolver.js")).toBe(true);
	});

	it("reaches pi's real map and inherits the native provider's default", async () => {
		const map = await piDefaultModelMap();
		expect(map.anthropic).toBeTruthy();

		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", track("anthropic@work")));
		expect(map["anthropic@work"]).toBe(map.anthropic);
	});

	it("covers all supported providers", async () => {
		const map = await piDefaultModelMap();
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", track("anthropic@a")));
		await adoptNativeDefaultModel("openai-codex", await nativeAlias("openai-codex", track("openai-codex@b")));
		await adoptNativeDefaultModel("openai", await nativeAlias("openai", track("openai@c")));
		expect(map["anthropic@a"]).toBe(map.anthropic);
		expect(map["openai-codex@b"]).toBe(map["openai-codex"]);
		expect(map["openai@c"]).toBe(map.openai);
	});

	it("satisfies pi's own hasDefaultModelProvider check", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@gate");
		expect(id in map).toBe(false);
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", id));
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
				{ provider: "openai", name: "work" },
			],
		});
		const pi = await harness(agentDir);
		track("anthropic@work");
		track("openai-codex@personal");
		track("openai@work");

		for (const [aliasId, native] of [
			["anthropic@work", "anthropic"],
			["openai-codex@personal", "openai-codex"],
			["openai@work", "openai"],
		]) {
			const wanted = map[native];
			const offered = pi.registry.getAll().filter((model) => model.provider === aliasId);
			expect(offered.some((model) => model.id === wanted), `${aliasId} offers ${wanted}`).toBe(true);
		}
	});

	it("releases only entries it installed", async () => {
		const map = await piDefaultModelMap();
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", track("anthropic@mine")));
		expect(map["anthropic@mine"]).toBe(map.anthropic);

		await releaseDefaultModel("anthropic@mine");
		expect("anthropic@mine" in map).toBe(false);
	});

	it("leaves an entry that predated this extension", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@preexisting");
		map[id] = "someone-elses-choice";

		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", id));
		await releaseDefaultModel(id);
		// Releasing must not delete a key we never installed.
		expect(map[id]).toBe("someone-elses-choice");
	});

	it("does not install a default the alias catalog cannot offer", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@narrowed");
		// A models.json overlay can leave the effective provider without its native default.
		await adoptNativeDefaultModel("anthropic", aliasOffering(id, ["some-other-model"]));
		expect(id in map).toBe(false);
	});

	it("withdraws an entry once the catalog stops offering it", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@shrunk");
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", id));
		expect(map[id]).toBe(map.anthropic);

		await adoptNativeDefaultModel("anthropic", aliasOffering(id, ["some-other-model"]));
		expect(id in map).toBe(false);
	});

	it("keeps an entry a new owner replaced with its own value", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@handover");
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", id));
		// A provider that took over the ID sets its own default.
		map[id] = "new-owners-model";

		await releaseDefaultModel(id);
		expect(map[id]).toBe("new-owners-model");
	});

	it("is a no-op for an unknown alias", async () => {
		const map = await piDefaultModelMap();
		const before = { ...map };
		await releaseDefaultModel("anthropic@never-seen");
		expect(Object.keys(map).sort()).toEqual(Object.keys(before).sort());
	});

	it("never clobbers an existing entry", async () => {
		const map = await piDefaultModelMap();
		const id = track("anthropic@pinned");
		map[id] = "already-chosen";
		await adoptNativeDefaultModel("anthropic", await nativeAlias("anthropic", id));
		expect(map[id]).toBe("already-chosen");
	});

	it("leaves no entry behind when loading fails", async () => {
		const map = await piDefaultModelMap();
		await writeStateFile(agentDir, "{ broken");
		await harness(agentDir);
		expect("anthropic@work" in map).toBe(false);
	});

	/**
	 * The in-process tests above share a warm module memo, which is exactly what hid the
	 * original bug: concurrent adoption on a cold start dropped every account but the
	 * first. Only a fresh process can catch a regression here.
	 */
	it("adopts every account on a cold start, not just the first", async () => {
		const moduleUrl = new URL("../src/default-model.ts", import.meta.url).href;
		const resolverPath = fileURLToPath(modelResolverSpecifier());
		const dir = await mkdtemp(join(tmpdir(), "pi-cold-start-"));
		const script = join(dir, "cold-start.ts");
		await writeFile(
			script,
			`import { adoptNativeDefaultModel } from ${JSON.stringify(moduleUrl)};
const { defaultModelPerProvider: map } = await import(${JSON.stringify(resolverPath)});
const alias = (id, provider) => ({ id, getModels: () => [{ id: map[provider] }] });
await Promise.all([
	adoptNativeDefaultModel("anthropic", alias("anthropic@one", "anthropic")),
	adoptNativeDefaultModel("openai-codex", alias("openai-codex@two", "openai-codex")),
]);
console.log(JSON.stringify({ one: map["anthropic@one"], two: map["openai-codex@two"] }));
`,
			"utf8",
		);

		const { stdout } = await run(process.execPath, ["--experimental-strip-types", script]);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) as string);
		expect(result.one).toBeTruthy();
		expect(result.two, "second concurrent account must also get a default").toBeTruthy();
	}, 30_000);
});
