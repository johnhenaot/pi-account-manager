import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import { type EffortModel, stream, streamSimple } from "./fixtures/openai-responses-effort.ts";

const TOKEN = "fake-chatgpt-access-token-for-effort-tests";
const context = () => normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
type Payload = { input: { type?: string }[]; reasoning?: { effort: string } };

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected live HTTP request in effort test"); }));
});
afterEach(() => vi.unstubAllGlobals());

function fixture(id = "gpt-6-luna") {
	const model: EffortModel = {
		...bundledProvider("openai")!.getModels().find((candidate) => candidate.id === "gpt-5.5")! as Model<"openai-responses">,
		id,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		compat: { supportsMidConvoEffort: true, supportsStrictMode: true, supportsLongCacheRetention: true },
	};
	// Synthetic future catalog; runtime dependencies stay pinned to Pi 1.2.0.
	Object.freeze(model.compat);
	Object.freeze(model);
	const base: Provider = {
		...bundledProvider("openai")!,
		getModels: () => [model],
		stream: (requestModel, transcript, options) => stream(requestModel as EffortModel, transcript, options as OpenAIResponsesOptions),
		streamSimple: (requestModel, transcript, options) => streamSimple(requestModel as EffortModel, transcript, options),
	};
	const alias = buildAlias(base, { provider: "openai", name: "work" });
	return { base, alias, model, aliasModel: alias.getModels()[0] as EffortModel };
}

function capture() {
	const requests: { url: string; authorization: string | null; body: Payload }[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, authorization: request.headers.get("authorization"), body: await request.json() as Payload });
		return new Response(`data: ${JSON.stringify({
			type: "response.completed", response: { id: "resp_fake", status: "completed", output: [] },
		})}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requests };
}

describe("OpenAI subscription effort (upstream #10930 simulation)", () => {
	for (const method of ["stream", "streamSimple"] as const) {
		const reasoning = (effort: "low" | "high" | "xhigh" | undefined) =>
			method === "stream" ? { reasoningEffort: effort } : { reasoning: effort };

		describe(method, () => {
			it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"])(
				"matches native subscription payloads and preserves requested effort on %s", async (id) => {
					const { base, alias, model, aliasModel } = fixture(id);
					const nativeSnapshot = structuredClone(model);
					const aliasSnapshot = structuredClone(aliasModel);
					Object.freeze(aliasModel);
					for (const effort of ["low", "high", "xhigh"] as const) {
						const { fetch, requests } = capture();
						const options = { apiKey: TOKEN, fetch, maxRetries: 0, maxTokens: 128, ...reasoning(effort) };
						const native = await base[method](model, context(), options).result();
						const named = await alias[method](aliasModel, context(), options).result();
						expect(native.stopReason).toBe("stop");
						expect(named.stopReason).toBe("stop");
						expect(named.provider).toBe("openai@work");
						expect(named.model).toBe(id);
						expect(requests).toHaveLength(2);
						expect(requests[1].body).toEqual(requests[0].body);
						for (const request of requests) {
							expect(request.url).toBe("https://api.openai.com/v1/responses");
							expect(request.authorization).toBe(`Bearer ${TOKEN}`);
							expect(request.body.input.some((item) => item.type === "configuration_update")).toBe(false);
							expect(request.body.reasoning?.effort).toBe(effort);
						}
					}
					expect(model).toEqual(nativeSnapshot);
					expect(aliasModel).toEqual(aliasSnapshot);
					expect(base.getModels()[0]).toBe(model);
					expect(alias.getModels()[0].compat).toBe(model.compat);
				},
			);

			it("reproduces the unfixed alias divergence", async () => {
				const { base, model, aliasModel } = fixture();
				const { fetch, requests } = capture();
				const options = { apiKey: TOKEN, fetch, maxRetries: 0, ...reasoning("high") };
				await base[method](model, context(), options).result();
				// Bypass buildAlias's request adaptation, retaining the named provider.
				await base[method](aliasModel, context(), options).result();
				expect(requests).toHaveLength(2);
				expect(requests[0].body.reasoning?.effort).toBe("high");
				expect(requests[0].body.input.some((item) => item.type === "configuration_update")).toBe(false);
				expect(requests[1].body.reasoning?.effort).toBe("medium");
				expect(requests[1].body.input.at(-1)).toEqual(update("high"));
			});

			it("omits effort updates when replaying a reply with a recorded effort", async () => {
				const { alias, aliasModel } = fixture();
				const { fetch, requests } = capture();
				const options = { apiKey: TOKEN, fetch, maxRetries: 0, ...reasoning("high") };
				const first = await alias[method](aliasModel, context(), options).result();
				const recorded = { ...first, content: [{ type: "text" as const, text: "previous reply" }], providerThinkingLevel: "high" };
				const history = normalizeContext({ messages: [
					{ role: "user", content: "one", timestamp: 0 }, recorded,
					{ role: "user", content: "two", timestamp: 1 },
				] });
				const result = await alias[method](aliasModel, history, { ...options, ...reasoning("low") }).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(2);
				expect(requests[1].body.input.some((item) => item.type === "configuration_update")).toBe(false);
				expect(requests[1].body.reasoning?.effort).toBe("low");
			});

			it.each(["thinking off", "compat off"] as const)("keeps effort updates absent with %s", async (kind) => {
				const { alias, aliasModel } = fixture();
				const model = kind === "compat off" ? { ...aliasModel, compat: { ...aliasModel.compat, supportsMidConvoEffort: false } } : aliasModel;
				const { fetch, requests } = capture();
				const result = await alias[method](model, context(), {
					apiKey: TOKEN, fetch, maxRetries: 0, ...reasoning(kind === "thinking off" ? undefined : "high"),
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(1);
				expect(requests[0].body.input.some((item) => item.type === "configuration_update")).toBe(false);
				expect(requests[0].body.reasoning?.effort).toBe(kind === "thinking off" ? "none" : "high");
			});

			it.each(["API key", "custom endpoint"] as const)("keeps upstream effort behavior for %s", async (kind) => {
				const { base, alias, aliasModel } = fixture();
				const model = kind === "custom endpoint" ? { ...aliasModel, baseUrl: "https://fake.example/v1" } : aliasModel;
				const { fetch, requests } = capture();
				const options = { apiKey: kind === "API key" ? "sk-fake-test-key" : TOKEN, fetch, maxRetries: 0, ...reasoning("high") };
				await base[method](model, context(), options).result();
				await alias[method](model, context(), options).result();
				expect(requests).toHaveLength(2);
				expect(requests[1].body).toEqual(requests[0].body);
				expect(requests[1].body.reasoning?.effort).toBe("medium");
				expect(requests[1].body.input.at(-1)).toEqual(update("high"));
				expect(model.compat?.supportsMidConvoEffort).toBe(true);
			});

			it("preserves effort mapping and lets the caller hook see the adapted request", async () => {
				const { alias, aliasModel } = fixture();
				const model = { ...aliasModel, thinkingLevelMap: { ...aliasModel.thinkingLevelMap, high: "xhigh" } } as EffortModel;
				const { fetch, requests } = capture();
				const onPayload = vi.fn((payload: unknown, requestModel: Model<Api>) => {
					expect((payload as Payload).reasoning?.effort).toBe("xhigh");
					expect(requestModel.provider).toBe("openai@work");
					expect(requestModel).not.toBe(model);
					expect((requestModel as EffortModel).compat?.supportsMidConvoEffort).toBe(false);
					expect((requestModel as EffortModel).compat?.supportsStrictMode).toBe(true);
				});
				const options = { apiKey: TOKEN, fetch, maxRetries: 0, onPayload, ...reasoning("high") };
				const result = await alias[method](model, context(), options).result();
				expect(result.stopReason).toBe("stop");
				expect(requests[0].body.reasoning?.effort).toBe("xhigh");
				expect(onPayload).toHaveBeenCalledTimes(1);
				expect(options.onPayload).toBe(onPayload);
				expect(model.compat?.supportsMidConvoEffort).toBe(true);
			});
		});
	}
});

describe("subscription adaptation scope", () => {
	for (const method of ["stream", "streamSimple"] as const) {
		it.each(["anthropic", "openai-codex", "other API", "missing token", "missing options"])(`${method} leaves %s requests untouched`, (kind) => {
			const { base, aliasModel } = fixture();
			const spy = vi.fn(base[method]);
			const provider = kind === "anthropic" || kind === "openai-codex" ? kind : "openai";
			const alias = buildAlias({ ...base, [method]: spy }, { provider, name: "work" });
			const model = kind === "other API" ? { ...aliasModel, api: "openai-completions" } as Model<"openai-completions"> : aliasModel;
			// Avoid a request: only verify the delegate receives the original objects.
			spy.mockImplementation(() => { throw new Error("delegate reached"); });
			const options: StreamOptions | undefined = kind === "missing options" ? undefined : kind === "missing token" ? {} : { apiKey: TOKEN };
			expect(() => alias[method](model, context(), options)).toThrow("delegate reached");
			expect(spy.mock.calls[0][0]).toBe(model);
			expect(spy.mock.calls[0][2]).toBe(options);
		});
	}
});
