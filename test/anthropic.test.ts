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
		"https://api.anthropic.com",
		"https://api.anthropic.com:8443",
		"http://api.anthropic.com",
	])("opts in %s like pi's anthropic provider, keeping other compat flags", (baseUrl) => {
		const { model, sent } = forwarded("anthropic", { baseUrl, compat: { supportsStrictTools: true } });
		expect(sent.compat).toEqual({ supportsStrictTools: true, supportsMessageThreads: true });
		expect(model.compat).toEqual({ supportsStrictTools: true });
	});

	it("treats an explicit supportsMessageThreads: undefined as unset and opts in", () => {
		const { sent } = forwarded("anthropic", {
			baseUrl: "https://api.anthropic.com",
			compat: { supportsMessageThreads: undefined, supportsStrictTools: true },
		});
		expect(sent.compat).toEqual({ supportsMessageThreads: true, supportsStrictTools: true });
	});

	it.each([
		["https://api.anthropic.com", false],
		["https://api.anthropic.com", true],
		["https://gateway.example.com", true],
	] as const)("forwards %s with explicit supportsMessageThreads: %s unchanged", (baseUrl, enabled) => {
		const { model, sent } = forwarded("anthropic", { baseUrl, compat: { supportsMessageThreads: enabled } });
		expect(sent).toBe(model);
	});

	it.each(["https://gateway.example.com", "not a URL"])("does not opt in %s", (baseUrl) => {
		const { model, sent } = forwarded("anthropic", { baseUrl });
		expect(sent).toBe(model);
	});

	it.each([
		["openai", "anthropic-messages"],
		["anthropic", "openai-responses"],
	] as const)("does not opt in %s using %s", (provider, api) => {
		const { model, sent } = forwarded(provider, { api, baseUrl: "https://api.anthropic.com" });
		expect(sent).toBe(model);
	});
});

describe("Anthropic alias session scoping", () => {
	const session = (apiKey: string, patch: Partial<Model<Api>>) =>
		forwarded("anthropic", patch, { sessionId: "session", apiKey }).sentOptions?.sessionId;

	it.each([
		{ baseUrl: "https://api.anthropic.com" },
		{ baseUrl: "https://gateway.example.com" },
		{ baseUrl: "https://api.anthropic.com", compat: { supportsMessageThreads: false } },
	])("scopes the session to the credential whether or not the alias enables threads: %o", (patch) => {
		const first = session("sk-ant-oat-fake-a", patch);
		expect(first).not.toBe("session");
		expect(session("sk-ant-oat-fake-a", patch)).toBe(first);
		expect(session("sk-ant-oat-fake-b", patch)).not.toBe(first);
	});
});
