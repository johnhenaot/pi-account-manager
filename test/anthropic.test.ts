import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildAlias } from "../src/alias.ts";
import { stubProvider } from "./helpers.ts";

const context = normalizeContext({ messages: [] });

describe.each(["stream", "streamSimple"] as const)("Anthropic alias %s", (method) => {
	it.each(["work", "personal"])("opts in only the direct endpoint and retains account %s", (name) => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, method);
		const alias = buildAlias(base, { provider: "anthropic", name });
		const model = { ...alias.getModels()[0], baseUrl: "https://api.anthropic.com/v1" };
		const options = { apiKey: `fake-${name}`, sessionId: "same-session", disableContinuation: true };
		alias[method](model, context, options);
		const [sent, sentContext, sentOptions] = native.mock.calls[0];
		expect(sent.provider).toBe(`anthropic@${name}`);
		expect(sent.compat).toMatchObject({ supportsMessageThreads: true });
		expect(sentContext).toBe(context);
		expect(sentOptions).toBe(options);
		expect(model).not.toHaveProperty("compat");
	});

	it.each([false, true, undefined])("preserves explicit supportsMessageThreads: %s and other compat flags", (enabled) => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, method);
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = {
			...alias.getModels()[0], baseUrl: "https://api.anthropic.com",
			compat: { supportsMessageThreads: enabled, supportsStrictTools: true },
		};
		alias[method](model, context);
		expect(native.mock.calls[0][0].compat).toEqual({ ...model.compat, supportsMessageThreads: enabled ?? true });
	});

	it.each([
		"https://gateway.example.com",
		"https://api.anthropic.com.gateway.example.com",
		"https://api.anthropic.com@gateway.example.com",
		"https://gateway.example.com/api.anthropic.com",
		"http://api.anthropic.com",
		"https://api.anthropic.com:8443",
		"not a URL",
	])("does not opt in %s", (baseUrl) => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, method);
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = { ...alias.getModels()[0], baseUrl };
		alias[method](model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});

	it("preserves an explicit gateway opt-in", () => {
		const base = stubProvider("anthropic");
		const native = vi.spyOn(base, method);
		const alias = buildAlias(base, { provider: "anthropic", name: "work" });
		const model = { ...alias.getModels()[0], baseUrl: "https://gateway.example.com", compat: { supportsMessageThreads: true, supportsStrictTools: false } };
		alias[method](model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});

	it.each([
		["openai", "anthropic-messages"],
		["anthropic", "openai-responses"],
	] as const)("does not opt in %s using %s", (provider, api) => {
		const base = stubProvider(provider);
		const native = vi.spyOn(base, method);
		const alias = buildAlias(base, { provider, name: "work" });
		const model: Model<Api> = { ...alias.getModels()[0], api, baseUrl: "https://api.anthropic.com" };
		alias[method](model, context);
		expect(native.mock.calls[0][0]).toBe(model);
	});
});
