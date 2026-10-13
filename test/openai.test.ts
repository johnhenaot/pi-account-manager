import type { Api, Model, OAuthCredential, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import { cleanupAgentDir, makeAgentDir, realRegistry } from "./helpers.ts";

const FORBIDDEN_FIELDS = [
	"max_output_tokens",
	"temperature",
	"prompt_cache_retention",
	"prompt_cache_options",
] as const;
const FAKE_TOKEN = "fake-chatgpt-access-token-for-tests";
const transcript = () => normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

let agentDir: string;

beforeEach(async () => {
	agentDir = await makeAgentDir();
	// Every allowed HTTP request in this file must use its explicitly injected stub.
	vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected live HTTP request in OpenAI test"); }));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await cleanupAgentDir(agentDir);
});

function fixture(explicitCacheMode = false): { base: Provider; alias: Provider; model: Model<"openai-responses"> } {
	const base = bundledProvider("openai")!;
	const alias = buildAlias(base, { provider: "openai", name: "work" });
	const nativeModel = alias.getModels().find((model) => model.id === "gpt-5.5") as Model<"openai-responses">;
	expect(nativeModel).toBeDefined();
	return {
		base,
		alias,
		model: {
			...nativeModel,
			compat: {
				...nativeModel.compat,
				supportsMaxOutputTokens: true,
				supportsLongCacheRetention: true,
				supportsExplicitPromptCacheMode: explicitCacheMode,
			},
		},
	};
}

function captureRequests() {
	const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
		const event = {
			type: "response.completed",
			response: { id: "resp_fake_for_tests", status: "completed", output: [] },
		};
		return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch, requests };
}

function requestOptions(fetch: typeof globalThis.fetch): StreamOptions {
	return { apiKey: FAKE_TOKEN, fetch, maxRetries: 0, maxTokens: 128, temperature: 0.2, cacheRetention: "long" };
}

function expectNoForbiddenFields(payload: unknown) {
	for (const field of FORBIDDEN_FIELDS) expect(payload).not.toHaveProperty(field);
}

function fakeCredential(label: string): OAuthCredential {
	return {
		type: "oauth",
		access: `fake-${label}-access-token-for-tests`,
		refresh: `fake-${label}-refresh-token-for-tests`,
		expires: Date.now() + 3_600_000,
		clientId: `fake-${label}-client-id-for-tests`,
		scopes: ["chatgpt.tokens.use.direct"],
	};
}

describe("OpenAI alias transport", () => {
	it("preserves the exact native subscription OAuth flow and its metadata", () => {
		const { base, alias } = fixture();
		expect(alias.auth.oauth).toBe(base.auth.oauth);
		expect(alias.auth.oauth).toMatchObject({
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
		});
		expect(alias.auth.apiKey).toBeUndefined();
		expect(base.auth.apiKey).toBeDefined();
		expect(alias.getModels().map((model) => ({ ...model, provider: "openai" }))).toEqual(base.getModels());
	});

	for (const method of ["stream", "streamSimple"] as const) {
		describe(method, () => {
			it.each([false, true])("omits subscription-incompatible fields and keeps alias attribution (explicit cache: %s)", async (explicit) => {
				const { alias, model } = fixture(explicit);
				const { fetch, requests } = captureRequests();
				const options = requestOptions(fetch);
				const stream = alias[method](model, transcript(), options);
				const providers: string[] = [];
				for await (const event of stream) {
					if ("partial" in event) providers.push(event.partial.provider);
					if (event.type === "done") providers.push(event.message.provider);
				}
				const result = await stream.result();
				expect(result.stopReason).toBe("stop");
				expect(result.provider).toBe("openai@work");
				expect(result.model).toBe(model.id);
				expect(providers.length).toBeGreaterThan(0);
				expect(new Set(providers)).toEqual(new Set(["openai@work"]));
				expect(requests).toHaveLength(1);
				expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
				expect(requests[0].headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
				expectNoForbiddenFields(requests[0].body);
				expect(options.onPayload).toBeUndefined();
				expect(options.maxTokens).toBe(128);
			});

			it("calls a mutating hook after omissions and preserves its undefined return", async () => {
				const { alias, model } = fixture();
				const { fetch, requests } = captureRequests();
				const onPayload = vi.fn((payload: unknown, requestModel: Model<Api>) => {
					expectNoForbiddenFields(payload);
					expect(requestModel.provider).toBe(alias.id);
					const params = payload as Record<string, unknown>;
					params.metadata = { source: "fake-hook-mutation" };
					// Native Pi also lets an explicit caller hook override the omission.
					params.temperature = 0.7;
				});
				const options = { ...requestOptions(fetch), onPayload };
				const result = await alias[method](model, transcript(), options).result();
				expect(result.stopReason).toBe("stop");
				expect(onPayload).toHaveBeenCalledTimes(1);
				expect(options.onPayload).toBe(onPayload);
				expect(requests[0].body.metadata).toEqual({ source: "fake-hook-mutation" });
				expect(requests[0].body.temperature).toBe(0.7);
			});

			it("awaits an asynchronous replacement hook after omissions", async () => {
				const { alias, model } = fixture(true);
				const { fetch, requests } = captureRequests();
				const onPayload = vi.fn(async (payload: unknown, requestModel: Model<Api>) => {
					expectNoForbiddenFields(payload);
					expect(requestModel.provider).toBe(alias.id);
					await Promise.resolve();
					return { ...(payload as Record<string, unknown>), metadata: { source: "fake-hook-replacement" }, temperature: 0.8 };
				});
				const result = await alias[method](model, transcript(), { ...requestOptions(fetch), onPayload }).result();
				expect(result.stopReason).toBe("stop");
				expect(onPayload).toHaveBeenCalledTimes(1);
				expect(requests[0].body.metadata).toEqual({ source: "fake-hook-replacement" });
				expect(requests[0].body.temperature).toBe(0.8);
			});

			it.each(["custom endpoint", "API key"] as const)("leaves ordinary payload fields intact for %s", async (kind) => {
				for (const explicit of [false, true]) {
					const { alias, model } = fixture(explicit);
					const { fetch, requests } = captureRequests();
					const requestModel = kind === "custom endpoint" ? { ...model, baseUrl: "https://fake-openai.example/v1" } : model;
					const options = { ...requestOptions(fetch), apiKey: kind === "API key" ? "sk-fake-api-key-for-tests" : FAKE_TOKEN };
					const result = await alias[method](requestModel, transcript(), options).result();
					expect(result.stopReason).toBe("stop");
					expect(requests).toHaveLength(1);
					expect(requests[0].body.max_output_tokens).toBe(128);
					expect(requests[0].body.temperature).toBe(0.2);
					if (explicit) expect(requests[0].body.prompt_cache_options).toEqual({ ttl: "30m" });
					else expect(requests[0].body.prompt_cache_retention).toBe("24h");
				}
			});
		});
	}
});

describe("OpenAI named credential isolation", () => {
	it("does not resolve ambient, native API-key, or native OAuth credentials for an alias", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-fake-ambient-api-key-for-tests");
		const { credentials, runtime, registry } = await realRegistry(agentDir);
		registry.registerProvider(buildAlias(registry.getProvider("openai"), { provider: "openai", name: "work" }));
		expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("sk-fake-ambient-api-key-for-tests");
		expect(await runtime.getAuth("openai@work")).toBeUndefined();

		await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-fake-native-api-key-for-tests" }));
		expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("sk-fake-native-api-key-for-tests");
		expect(await runtime.getAuth("openai@work")).toBeUndefined();

		const native = fakeCredential("native");
		await credentials.modify("openai", async () => native);
		expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe(native.access);
		expect(await runtime.getAuth("openai@work")).toBeUndefined();
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("openai@work").configured).toBe(false);
	});

	it("resolves and streams each alias token independently, including after one account logs out", async () => {
		const { credentials, runtime, registry } = await realRegistry(agentDir);
		for (const name of ["work", "personal"]) {
			registry.registerProvider(buildAlias(registry.getProvider("openai"), { provider: "openai", name }));
		}
		const work = fakeCredential("work");
		const personal = fakeCredential("personal");
		await credentials.modify("openai@work", async () => work);
		expect((await runtime.getAuth("openai@work"))?.auth.apiKey).toBe(work.access);
		expect(await runtime.getAuth("openai@personal")).toBeUndefined();
		await credentials.modify("openai@personal", async () => personal);
		const { fetch, requests } = captureRequests();
		for (const [index, name] of ["work", "personal"].entries()) {
			const model = registry.find(`openai@${name}`, "gpt-5.5")!;
			const result = await runtime.streamSimple(model, transcript(), { fetch, maxRetries: 0, maxTokens: 128 }).result();
			expect(result.stopReason).toBe("stop");
			expect(result.provider).toBe(`openai@${name}`);
			expect(requests[index].headers.get("authorization")).toBe(`Bearer ${index === 0 ? work.access : personal.access}`);
			expectNoForbiddenFields(requests[index].body);
		}
		expect(credentials.entries.has("openai")).toBe(false);
		await runtime.logout("openai@work");
		expect(await runtime.getAuth("openai@work")).toBeUndefined();
		expect((await runtime.getAuth("openai@personal"))?.auth.apiKey).toBe(personal.access);
		expect(credentials.entries.get("openai@personal")).toEqual(personal);
		expect(registry.getProvider("openai@work")).toBeDefined();
	});
});
