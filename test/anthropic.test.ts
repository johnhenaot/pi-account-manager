import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildAlias } from "../src/alias.ts";
import { stubProvider } from "./helpers.ts";

const context = normalizeContext({ messages: [] });

describe("Anthropic alias compatibility", () => {
	it.each([false, undefined])("preserves explicit supportsMessageThreads: %s and other compat flags", (enabled) => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, "streamSimple");
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = {
			...alias.getModels()[0], baseUrl: "https://api.anthropic.com",
			compat: { supportsMessageThreads: enabled, supportsStrictTools: true },
		};
		alias.streamSimple(model, context);
		expect(native.mock.calls[0][0].compat).toEqual({ ...model.compat, supportsMessageThreads: enabled ?? true });
	});

	it.each([
		"https://api.anthropic.com.gateway.example.com",
		"https://api.anthropic.com@gateway.example.com",
		"http://api.anthropic.com",
		"https://api.anthropic.com:8443",
		"not a URL",
	])("does not opt in %s", (baseUrl) => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, "streamSimple");
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = { ...alias.getModels()[0], baseUrl };
		alias.streamSimple(model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});

	it("preserves an explicit gateway opt-in", () => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, "streamSimple");
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = { ...alias.getModels()[0], baseUrl: "https://gateway.example.com", compat: { supportsMessageThreads: true, supportsStrictTools: false } };
		alias.streamSimple(model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});

	it.each([
		["openai", "anthropic-messages"],
		["anthropic", "openai-responses"],
	] as const)("does not opt in %s using %s", (provider, api) => {
		const base = stubProvider(provider);
		const native = vi.spyOn(base, "streamSimple");
		const alias = buildAlias(base, { provider, name: "work" });
		const model: Model<Api> = { ...alias.getModels()[0], api, baseUrl: "https://api.anthropic.com" };
		alias.streamSimple(model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});
});
