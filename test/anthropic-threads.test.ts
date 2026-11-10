import type { Message, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { cleanupSessionResources, getCacheWarmingRequestOptions, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAlias, bundledProvider } from "../src/alias.ts";
import { cleanupAgentDir, makeAgentDir, realRegistry } from "./helpers.ts";

// Exercise the published Pi provider and Anthropic SDK, replacing only HTTP.
// No provider mocks, real credentials, network calls, or billable requests.
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

function fixture(name = "work"): { alias: Provider; model: Model<"anthropic-messages"> } {
	const alias = buildAlias(bundledProvider("anthropic"), { provider: "anthropic", name });
	const model = alias.getModels().find((candidate) => candidate.id === MODEL_ID) as Model<"anthropic-messages">;
	expect(model).toBeDefined();
	return { alias, model };
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: { messages: unknown[]; thread?: { type: string; previous_message_id?: string }; [key: string]: unknown };
}

function reply(id: string, interrupted = false): Response {
	const events = [
		{ type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Reply ${id}` } },
		{ type: "content_block_stop", index: 0 },
		...(!interrupted ? [
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		] : []),
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function rejection(code?: string, message = "Thread rejected"): Response {
	return new Response(JSON.stringify({ type: "error", error: {
		type: "invalid_request_error", message, ...(code ? { details: { error_code: code } } : {}),
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

function expectContinuation(request: CapturedRequest, previousMessageId: string) {
	expect(request.body.thread).toEqual({ type: "continue", previous_message_id: previousMessageId });
	expect(request.body.messages).toHaveLength(1);
	expect(request.body).not.toHaveProperty("system");
	expect(request.body).not.toHaveProperty("tools");
}

describe.each(["stream", "streamSimple"] as const)("Anthropic threads via real SDK %s", (method) => {
	it("creates a full thread, continues with only new messages, and keeps alias attribution", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const snapshot = structuredClone(model);
		const first = await alias[method](model, context(messages), options).result();
		expect(first.stopReason).toBe("stop");
		messages.push(first, userMessage("follow up"));
		const stream = alias[method](model, context(messages), options);
		const providers: string[] = [];
		for await (const event of stream) {
			if ("partial" in event) providers.push(event.partial.provider);
			if (event.type === "done") providers.push(event.message.provider);
		}
		const second = await stream.result();
		expect(second.stopReason).toBe("stop");
		expect(first.provider).toBe(alias.id);
		expect(second.provider).toBe(alias.id);
		expect(providers.length).toBeGreaterThan(0);
		expect(new Set(providers)).toEqual(new Set([alias.id]));
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

	it("starts fresh on work → personal → work in one session, using each account's token", async () => {
		const work = fixture("work");
		const personal = fixture("personal");
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		for (const [index, account] of [work, personal, work].entries()) {
			const name = account === work ? "work" : "personal";
			const result = await account.alias[method](account.model, context(messages), { ...options, apiKey: token(name) }).result();
			expect(result.stopReason).toBe("stop");
			expect(result.provider).toBe(account.alias.id);
			expectFull(requests[index], 2 * index + 1);
			expect(requests[index].headers.get("authorization")).toBe(`Bearer ${token(name)}`);
			messages.push(result, userMessage(`next ${index}`));
		}
		const result = await work.alias[method](work.model, context(messages), options).result();
		expect(result.stopReason).toBe("stop");
		expectContinuation(requests[3], "msg_3");
	});

	it("uses a refreshed token without replacing Pi's same-account continuation state", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const first = await alias[method](model, context(messages), options).result();
		messages.push(first, userMessage("follow up"));
		const result = await alias[method](model, context(messages), { ...options, apiKey: token("work-refreshed") }).result();
		expect(result.stopReason).toBe("stop");
		expectContinuation(requests[1], first.responseId!);
		expect(requests[1].headers.get("authorization")).toBe(`Bearer ${token("work-refreshed")}`);
	});

	it.each(["thread_not_found", "thread_already_continued", "thread_continue_in_flight", "thread_fingerprint_mismatch"])(
		"recovers %s with one full new thread, then continues that thread", async (code) => {
			const { alias, model } = fixture();
			const { requests, options } = transport([() => reply("msg_original"), () => rejection(code)]);
			const messages = [userMessage("hello")];
			const first = await alias[method](model, context(messages), options).result();
			messages.push(first, userMessage("follow up"));
			const recovered = await alias[method](model, context(messages), options).result();
			expect(recovered.stopReason).toBe("stop");
			expect(requests).toHaveLength(3);
			expectContinuation(requests[1], first.responseId!);
			expectFull(requests[2], 3);
			expect(JSON.stringify(requests[2].body.messages)).toContain("hello");
			expect(JSON.stringify(recovered)).toContain("anthropic_thread_fallback");
			messages.push(recovered, userMessage("after recovery"));
			await alias[method](model, context(messages), options).result();
			expectContinuation(requests[3], recovered.responseId!);
		},
	);

	it.each(["thread_unsupported_request", undefined])("falls back without threads for an unsupported endpoint (%s)", async (code) => {
		const { alias, model } = fixture();
		const { requests, options } = transport([() => rejection(code, "thread: Extra inputs are not permitted")]);
		const messages = [userMessage("hello")];
		const first = await alias[method](model, context(messages), options).result();
		expect(first.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expectFull(requests[0], 1);
		expectFull(requests[1], 1, false);
		messages.push(first, userMessage("follow up"));
		await alias[method](model, context(messages), options).result();
		expectFull(requests[2], 3, false);
		cleanupSessionResources(SESSION_ID);
		await alias[method](model, context(messages), options).result();
		expectFull(requests[3], 3);
	});

	it("keeps cache warming from consuming or replacing the real conversation thread", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const first = await alias[method](model, context(messages), options).result();
		const warmingOptions = getCacheWarmingRequestOptions(options, new AbortController().signal);
		const warmed = await alias[method](model, context(messages), warmingOptions).result();
		expect(warmed.stopReason).toBe("stop");
		expectFull(requests[1], 1, false);
		expect(requests[1].body.max_tokens).toBe(1);
		expect(options).not.toHaveProperty("disableContinuation");
		messages.push(first, userMessage("follow up"));
		await alias[method](model, context(messages), options).result();
		expectContinuation(requests[2], first.responseId!);
		expect(requests[2].body.thread?.previous_message_id).not.toBe(warmed.responseId);
	});

	it.each(["explicit opt-out", "no session", "no cache", "gateway"] as const)("does not create threads with %s", async (kind) => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const requestModel = kind === "explicit opt-out"
			? { ...model, compat: { ...model.compat, supportsMessageThreads: false } }
			: kind === "gateway" ? { ...model, baseUrl: "https://gateway.example.test" } : model;
		const requestOptions = kind === "no session" ? { ...options, sessionId: undefined }
			: kind === "no cache" ? { ...options, cacheRetention: "none" as const } : options;
		const result = await alias[method](requestModel, context([userMessage("hello")]), requestOptions).result();
		expect(result.stopReason).toBe("stop");
		expectFull(requests[0], 1, false);
		expect(requests[0].headers.get("anthropic-beta")).not.toContain("message-threads-2026-08-12");
	});

	it("frees a successful thread when the session is cleaned up", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport();
		const messages = [userMessage("hello")];
		const first = await alias[method](model, context(messages), options).result();
		messages.push(first, userMessage("follow up"));
		cleanupSessionResources(SESSION_ID);
		await alias[method](model, context(messages), options).result();
		expectFull(requests[1], 3);
	});

	it("does not hide unrelated request errors with a fallback", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport([() => rejection("unknown_model", "Unknown model")]);
		const result = await alias[method](model, context([userMessage("hello")]), options).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unknown model");
		expect(requests).toHaveLength(1);
	});

	it("does not replay or continue an interrupted stream", async () => {
		const { alias, model } = fixture();
		const { requests, options } = transport([() => reply("msg_interrupted", true)]);
		const messages = [userMessage("hello")];
		const result = await alias[method](model, context(messages), options).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("before message_stop");
		expect(requests).toHaveLength(1);
		await alias[method](model, context(messages), options).result();
		expectFull(requests[1], 1);
	});
});

describe("Anthropic named credential isolation with the real runtime", () => {
	it("never borrows native or ambient credentials, and keeps personal working after work logs out", async () => {
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
			// Omit apiKey so the actual runtime must resolve each alias's stored OAuth credential.
			const { apiKey: _apiKey, ...runtimeOptions } = options;
			const messages = [userMessage("hello")];
			for (const [index, name] of ["work", "personal"].entries()) {
				const model = registry.find(`anthropic@${name}`, MODEL_ID)!;
				const result = await runtime.streamSimple(model, context(messages), runtimeOptions).result();
				expect(result.stopReason).toBe("stop");
				expect(result.provider).toBe(`anthropic@${name}`);
				expect(requests[index].headers.get("authorization")).toBe(`Bearer ${token(name)}`);
				expectFull(requests[index], 2 * index + 1);
				messages.push(result, userMessage(`after ${name}`));
			}
			await runtime.logout("anthropic@work");
			expect(await runtime.getAuth("anthropic@work")).toBeUndefined();
			expect((await runtime.getAuth("anthropic@personal"))?.auth.apiKey).toBe(token("personal"));
			const result = await runtime.streamSimple(registry.find("anthropic@personal", MODEL_ID)!, context(messages), runtimeOptions).result();
			expect(result.stopReason).toBe("stop");
			expectContinuation(requests[2], "msg_2");
			expect(requests[2].headers.get("authorization")).toBe(`Bearer ${token("personal")}`);
		} finally {
			await cleanupAgentDir(agentDir);
		}
	});
});
