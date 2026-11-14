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
	it.each([
		["https://api.anthropic.com", { supportsStrictTools: true }],
		["https://api.anthropic.com:8443", { supportsMessageThreads: undefined, supportsStrictTools: true }],
	])("opts in %s like pi's anthropic provider, keeping other compat flags", (baseUrl, compat) => {
		const { model, sent } = forwarded("anthropic", { baseUrl, compat });
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
		["openai", "anthropic-messages", "https://api.anthropic.com"],
		["anthropic", "openai-responses", "https://api.anthropic.com"],
	] as const)("does not opt in %s using %s on %s", (provider, api, baseUrl) => {
		const { model, sent } = forwarded(provider, { api, baseUrl });
		expect(sent).toBe(model);
	});
});

describe("Anthropic alias session scoping", () => {
	const session = (apiKey: string, patch: Partial<Model<Api>>) =>
		forwarded("anthropic", patch, { sessionId: "session", apiKey }).sentOptions?.sessionId;

	it.each([
		{ baseUrl: "https://api.anthropic.com" },
		{ baseUrl: "https://gateway.example.com" },
	])("scopes the session to the credential whether or not the alias enables threads: %o", (patch) => {
		const first = session("sk-ant-oat-fake-a", patch);
		expect(first).not.toBe("session");
		expect(session("sk-ant-oat-fake-a", patch)).toBe(first);
		expect(session("sk-ant-oat-fake-b", patch)).not.toBe(first);
	});
});
