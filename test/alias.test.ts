import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
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
			stream: (...args: unknown[]) => {
				calls.push(["stream", args[0]]);
				return "S" as never;
			},
			streamSimple: (...args: unknown[]) => {
				calls.push(["simple", args[0]]);
				return "SS" as never;
			},
		} as Provider;
		const alias = makeAlias(fakeBase, work);
		const model = alias.getModels()[0];
		expect(alias.stream(model as never, { messages: [] } as never)).toBe("S");
		expect(alias.streamSimple(model, { messages: [] } as never)).toBe("SS");
		// The alias model (provider = alias id) is passed through so pi-ai stamps the alias id
		// on every assistant stream event and finalized message (spec §5).
		expect(calls).toEqual([
			["stream", model],
			["simple", model],
		]);
	});

	it("throws for missing base, missing OAuth, empty catalog", () => {
		expect(() => makeAlias(undefined, work)).toThrow(/not available/);
		expect(() =>
			makeAlias(
				{ ...anthropic, auth: { apiKey: anthropic.auth.apiKey } } as Provider,
				work,
			),
		).toThrow(/OAuth/);
		expect(() =>
			makeAlias({ ...anthropic, getModels: () => [] } as Provider, work),
		).toThrow(/model catalog/);
	});
});
