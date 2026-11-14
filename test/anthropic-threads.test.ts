import type { Message, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { cleanupSessionResources, getCacheWarmingRequestOptions, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import { cleanupAgentDir, makeAgentDir, realRegistry } from "./helpers.ts";

const MODEL_ID = "claude-sonnet-5";
const SESSION_ID = "fake-anthropic-thread-session";
const token = (name: string) => `sk-ant-oat-fake-${name}-for-tests`;
const userMessage = (content: string): Message => ({ role: "user", content, timestamp: 0 });
const context = (messages: Message[]) => normalizeContext({
	systemPrompt: "Test system prompt",
	tools: [{ name: "lookup", description: "Test tool", parameters: { type: "object", properties: {} } }],
	messages,
});

beforeEach(() => {
	cleanupSessionResources();
	vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected live HTTP request in Anthropic test"); }));
});

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function fixture(): { alias: Provider; model: Model<"anthropic-messages"> } {
	const alias = buildAlias(bundledProvider("anthropic"), { provider: "anthropic", name: "work" });
	const model = alias.getModels().find((candidate) => candidate.id === MODEL_ID) as Model<"anthropic-messages">;
	expect(model).toBeDefined();
	return { alias, model };
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: { messages: unknown[]; thread?: { type: string; previous_message_id?: string }; [key: string]: unknown };
}

function reply(id: string): Response {
	const events = [
		{ type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Reply ${id}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function rejection(code: string): Response {
	return new Response(JSON.stringify({ type: "error", error: {
		type: "invalid_request_error", message: "Thread rejected", details: { error_code: code },
	} }), { status: 400, headers: { "content-type": "application/json" } });
}

function transport(responses: (() => Response)[] = []) {
	const requests: CapturedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers, body: await request.json() as CapturedRequest["body"] });
		return responses.shift()?.() ?? reply(`msg_${requests.length}`);
	};
	const options: StreamOptions = { apiKey: token("work"), fetch, sessionId: SESSION_ID, maxRetries: 0, maxTokens: 128 };
	return { requests, options };
}

function expectFull(request: CapturedRequest, count: number, thread = true) {
	expect(request.body.messages).toHaveLength(count);
	expect(request.body.system).toBeDefined();
	expect(request.body.tools).toBeDefined();
	if (thread) expect(request.body.thread).toEqual({ type: "create" });
	else expect(request.body).not.toHaveProperty("thread");
}

function expectContinuation(request: CapturedRequest, previousMessageId: string, count = 1) {
	expect(request.body.thread).toEqual({ type: "continue", previous_message_id: previousMessageId });
	expect(request.body.messages).toHaveLength(count);
	expect(request.body).not.toHaveProperty("system");
	expect(request.body).not.toHaveProperty("tools");
}

describe("Anthropic threads via real SDK", () => {
	it.each(["stream", "streamSimple"] as const)("continues a full thread through %s with alias attribution", async (method) => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const snapshot = structuredClone(model);
		const first = await alias[method](model, context(messages), options).result();
		expect(first.stopReason).toBe("stop");
		messages.push(first, userMessage("follow up"));
		const second = await alias[method](model, context(messages), options).result();
		expect(second.stopReason).toBe("stop");
		expect(first.provider).toBe(alias.id);
		expect(second.provider).toBe(alias.id);
		expect(requests).toHaveLength(2);
		expectFull(requests[0], 1);
		expectContinuation(requests[1], first.responseId!);
		for (const request of requests) {
			expect(new URL(request.url).origin).toBe("https://api.anthropic.com");
			expect(request.headers.get("authorization")).toBe(`Bearer ${token("work")}`);
			expect(request.headers.get("anthropic-beta")).toContain("message-threads-2026-08-12");
		}
		expect(model).toEqual(snapshot);
	});

	it("recovers an expired thread with a full request, then continues it", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport([() => reply("msg_original"), () => rejection("thread_not_found")]);
		const messages = [userMessage("hello")];
		const first = await alias.streamSimple(model, context(messages), options).result();
		messages.push(first, userMessage("follow up"));
		const recovered = await alias.streamSimple(model, context(messages), options).result();
		expect(recovered.stopReason).toBe("stop");
		expect(requests).toHaveLength(3);
		expectContinuation(requests[1], first.responseId!);
		expectFull(requests[2], 3);
		expect(JSON.stringify(requests[2].body.messages)).toContain("hello");
		expect(JSON.stringify(recovered)).toContain("anthropic_thread_fallback");
		messages.push(recovered, userMessage("after recovery"));
		await alias.streamSimple(model, context(messages), options).result();
		expectContinuation(requests[3], recovered.responseId!);
	});

	it("keeps unsupported-thread fallback scoped to the account", async () => {
		const { alias: work, model: workModel } = fixture();
		const personal = buildAlias(bundledProvider("anthropic"), { provider: "anthropic", name: "personal" });
		const personalModel = personal.getModels().find((model) => model.id === MODEL_ID)!;
		const { requests, options } = transport([() => rejection("thread_unsupported_request")]);
		const messages = [userMessage("hello")];
		const first = await work.streamSimple(workModel, context(messages), options).result();
		expect(first.stopReason).toBe("stop");
		expectFull(requests[1], 1, false);
		const personalOptions = { ...options, apiKey: token("personal") };
		const second = await personal.streamSimple(personalModel, context(messages), personalOptions).result();
		expect(second.stopReason).toBe("stop");
		expectFull(requests[2], 1);
		await work.streamSimple(workModel, context(messages), options).result();
		expectFull(requests[3], 1, false);
		messages.push(second, userMessage("follow up"));
		await personal.streamSimple(personalModel, context(messages), personalOptions).result();
		expectContinuation(requests[4], second.responseId!);
		cleanupSessionResources(SESSION_ID);
		await work.streamSimple(workModel, context(messages), options).result();
		await personal.streamSimple(personalModel, context(messages), personalOptions).result();
		expectFull(requests[5], 3);
		expectFull(requests[6], 3);
	});

	it.each([
		"https://api.anthropic.com",
		"https://api.anthropic.com:8443",
		"http://api.anthropic.com",
	])("starts a full thread after replacing the login on %s", async (baseUrl) => {
		const { alias, model: bundled } = fixture();
		const model = { ...bundled, baseUrl };
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const first = await alias.streamSimple(model, context(messages), options).result();
		messages.push(first, userMessage("after login"));
		const second = await alias.streamSimple(model, context(messages), { ...options, apiKey: token("replaced") }).result();
		expect(second.stopReason).toBe("stop");
		expectFull(requests[1], 3);
	});

	it("does not let an in-flight old login replace the new login's thread", async () => {
		const { alias, model } = fixture();
		let releaseOld!: () => void;
		let signalStarted!: () => void;
		const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
		const started = new Promise<void>((resolve) => { signalStarted = resolve; });
		const { requests, options } = transport();
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.headers.get("authorization") === `Bearer ${token("old")}`) {
				signalStarted();
				await gate;
				return reply("msg_old");
			}
			return options.fetch!(input, init);
		};
		const messages = [userMessage("hello")];
		const oldRequest = alias.streamSimple(model, context(messages), { ...options, apiKey: token("old"), fetch }).result();
		await started;
		const nextOptions = { ...options, apiKey: token("new"), fetch };
		const current = await alias.streamSimple(model, context(messages), nextOptions).result();
		releaseOld();
		expect((await oldRequest).stopReason).toBe("stop");
		expect(current.stopReason).toBe("stop");
		messages.push(current, userMessage("follow up"));
		await alias.streamSimple(model, context(messages), nextOptions).result();
		expectContinuation(requests[1], current.responseId!);
	});

	it("keeps cache warming from consuming or replacing the real conversation thread", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const first = await alias.streamSimple(model, context(messages), options).result();
		const warmingOptions = getCacheWarmingRequestOptions(options, new AbortController().signal);
		const warmed = await alias.streamSimple(model, context(messages), warmingOptions).result();
		expect(warmed.stopReason).toBe("stop");
		expectFull(requests[1], 1, false);
		expect(requests[1].body.max_tokens).toBe(1);
		expect(options).not.toHaveProperty("disableContinuation");
		messages.push(first, userMessage("follow up"));
		await alias.streamSimple(model, context(messages), options).result();
		expectContinuation(requests[2], first.responseId!);
		expect(requests[2].body.thread?.previous_message_id).not.toBe(warmed.responseId);
	});
});

describe("Anthropic named credential isolation with the real runtime", () => {
	it.each([false, true])("starts a full thread after replacing the login (gateway=%s)", async (gateway) => {
		const agentDir = await makeAgentDir();
		try {
			const { credentials, runtime, registry } = await realRegistry(agentDir);
			registry.registerProvider(buildAlias(registry.getProvider("anthropic"), { provider: "anthropic", name: "work" }));
			const credential = (name: string) => ({ type: "oauth" as const, access: token(name), refresh: `fake-${name}-refresh`, expires: Date.now() + 3_600_000 });
			const model = {
				...registry.find("anthropic@work", MODEL_ID)!,
				...(gateway ? { baseUrl: "https://gateway.example.test", compat: { supportsMessageThreads: true } } : {}),
			};
			const { requests, options } = transport();
			const { apiKey: _apiKey, ...runtimeOptions } = options;
			const messages = [userMessage("hello")];
			await credentials.modify("anthropic@work", async () => credential("old"));
			const first = await runtime.streamSimple(model, context(messages), runtimeOptions).result();
			expect(first.stopReason).toBe("stop");
			messages.push(first, userMessage("after login"));
			await runtime.logout("anthropic@work");
			await credentials.modify("anthropic@work", async () => credential("new"));
			const second = await runtime.streamSimple(model, context(messages), runtimeOptions).result();
			expect(second.stopReason).toBe("stop");
			expect(requests[1].headers.get("authorization")).toBe(`Bearer ${token("new")}`);
			expectFull(requests[1], 3);
			messages.push(second, userMessage("continue new account"));
			await runtime.streamSimple(model, context(messages), runtimeOptions).result();
			expectContinuation(requests[2], second.responseId!);
		} finally {
			await cleanupAgentDir(agentDir);
		}
	});

	it("isolates work → personal → work threads and credentials, including logout", async () => {
		const agentDir = await makeAgentDir();
		try {
			vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-fake-ambient-key-for-tests");
			const { credentials, runtime, registry } = await realRegistry(agentDir);
			for (const name of ["work", "personal"]) {
				registry.registerProvider(buildAlias(registry.getProvider("anthropic"), { provider: "anthropic", name }));
			}
			expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-fake-ambient-key-for-tests");
			expect(await runtime.getAuth("anthropic@work")).toBeUndefined();
			await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-fake-native-key-for-tests" }));
			expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-fake-native-key-for-tests");
			expect(await runtime.getAuth("anthropic@work")).toBeUndefined();
			const credential = (name: string) => ({ type: "oauth" as const, access: token(name), refresh: `fake-${name}-refresh`, expires: Date.now() + 3_600_000 });
			await credentials.modify("anthropic", async () => credential("native"));
			expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe(token("native"));
			expect(await runtime.getAuth("anthropic@work")).toBeUndefined();
			await credentials.modify("anthropic@work", async () => credential("work"));
			expect(await runtime.getAuth("anthropic@personal")).toBeUndefined();
			await credentials.modify("anthropic@personal", async () => credential("personal"));
			const { requests, options } = transport();
			const { apiKey: _apiKey, ...runtimeOptions } = options;
			const messages = [userMessage("hello")];
			for (const [index, name] of ["work", "personal", "work", "personal"].entries()) {
				const model = registry.find(`anthropic@${name}`, MODEL_ID)!;
				const result = await runtime.streamSimple(model, context(messages), runtimeOptions).result();
				expect(result.stopReason).toBe("stop");
				expect(result.provider).toBe(`anthropic@${name}`);
				expect(requests[index].headers.get("authorization")).toBe(`Bearer ${token(name)}`);
				if (index < 2) expectFull(requests[index], 2 * index + 1);
				else expectContinuation(requests[index], `msg_${index - 1}`, 3);
				messages.push(result, userMessage(`after ${name}`));
			}
			await runtime.logout("anthropic@work");
			expect(await runtime.getAuth("anthropic@work")).toBeUndefined();
			expect((await runtime.getAuth("anthropic@personal"))?.auth.apiKey).toBe(token("personal"));
			const result = await runtime.streamSimple(registry.find("anthropic@personal", MODEL_ID)!, context(messages), runtimeOptions).result();
			expect(result.stopReason).toBe("stop");
			expectContinuation(requests[4], "msg_4");
			expect(requests[4].headers.get("authorization")).toBe(`Bearer ${token("personal")}`);
		} finally {
			await cleanupAgentDir(agentDir);
		}
	});
});
