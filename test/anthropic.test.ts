import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "../src/account.ts";
import { buildAlias } from "../src/alias.ts";
import { stubProvider } from "./helpers.ts";

const context = normalizeContext({ messages: [] });

function forwarded(provider: ProviderId, patch: Partial<Model<Api>>, options?: StreamOptions) {
	const base = stubProvider(provider);
	const native = vi.spyOn(base, "streamSimple");
	const alias = buildAlias(base, { provider, name: "work" });
	const model = { ...alias.getModels()[0], ...patch } as Model<Api>;
	alias.streamSimple(model, context, options);
	const [sent, , sentOptions] = native.mock.calls[0];
	return { model, sent, sentOptions };
}

describe("Anthropic alias compatibility", () => {
	it("opts in api.anthropic.com like pi's anthropic provider, keeping other compat flags", () => {
		const compat = { supportsStrictTools: true };
		const { model, sent } = forwarded("anthropic", { baseUrl: "https://api.anthropic.com", compat });
		expect(sent.compat).toEqual({ supportsStrictTools: true, supportsMessageThreads: true });
		expect(model.compat).toEqual(compat);
	});

	it.each([
		["https://api.anthropic.com", false],
		["https://gateway.example.com", true],
	] as const)("forwards %s with explicit supportsMessageThreads: %s unchanged", (baseUrl, enabled) => {
		const { model, sent } = forwarded("anthropic", { baseUrl, compat: { supportsMessageThreads: enabled } });
		expect(sent).toBe(model);
	});

	it.each([
		["anthropic", "anthropic-messages", "https://gateway.example.com"],
		["anthropic", "openai-responses", "https://api.anthropic.com"],
	] as const)("does not opt in %s using %s on %s", (provider, api, baseUrl) => {
		const { model, sent } = forwarded(provider, { api, baseUrl });
		expect(sent).toBe(model);
	});
});
