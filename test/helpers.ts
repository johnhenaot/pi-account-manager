import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, CredentialInfo, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import createAccountManager from "../src/index.ts";
import { statePath } from "../src/state.ts";

export async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-account-manager-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

export async function cleanupAgentDir(dir: string): Promise<void> {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(dir, { recursive: true, force: true });
}

export const writeStateFile = async (agentDir: string, body: unknown): Promise<void> => {
	await mkdir(join(agentDir, "pi-account-manager"), { recursive: true });
	await writeFile(statePath(agentDir), typeof body === "string" ? body : JSON.stringify(body), "utf8");
};

export const readStateFile = (agentDir: string): Promise<string> => readFile(statePath(agentDir), "utf8");

export const oauthCredential = (): Credential => ({
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 3_600_000,
});

export function memoryCredentials(): CredentialStore & { entries: Map<string, Credential> } {
	const entries = new Map<string, Credential>();
	return {
		entries,
		async read(providerId) {
			return entries.get(providerId);
		},
		async list(): Promise<readonly CredentialInfo[]> {
			return [...entries].map(([providerId, credential]) => ({ providerId, type: credential.type }));
		},
		async modify(providerId, fn) {
			const next = await fn(entries.get(providerId));
			if (next) entries.set(providerId, next);
			return entries.get(providerId);
		},
		async delete(providerId) {
			entries.delete(providerId);
		},
	};
}

export async function realRegistry(agentDir: string, modelsPath: string | null = null) {
	const credentials = memoryCredentials();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	return { credentials, runtime, registry: new ModelRegistry(runtime) };
}

export function stubProvider(id: string, options: { oauth?: boolean; models?: number } = {}): Provider {
	const models = Array.from({ length: options.models ?? 2 }, (_, index) => ({
		id: `model-${index}`,
		name: `Model ${index}`,
		api: "anthropic-messages",
		provider: id,
		baseUrl: "https://stub.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	})) as Model<Api>[];

	const echo = (model: Model<Api>) => {
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		});
		stream.end();
		return stream;
	};

	const apiKeyOnly = {
		apiKey: {
			name: "key",
			async resolve() {
				return { auth: { apiKey: "k" } };
			},
		},
	};

	return {
		id,
		name: id,
		baseUrl: "https://stub.example.com",
		auth:
			options.oauth === false
				? apiKeyOnly
				: {
						apiKey: {
							name: "key",
							async resolve() {
								return undefined;
							},
						},
						oauth: {
							name: "Stub OAuth",
							async login() {
								return oauthCredential() as never;
							},
							async refresh(credential) {
								return credential;
							},
							async toAuth() {
								return { apiKey: "oauth-token" };
							},
						},
					},
		getModels: () => models,
		stream: echo,
		streamSimple: echo,
	};
}

export interface Notification {
	message: string;
	type: string;
}

export interface HarnessOptions {
	editorText?: string;
	answers?: (string | undefined)[];
	rejectProviderId?: string;
	extension?: typeof createAccountManager;
}

export async function harness(agentDir: string, options: HarnessOptions = {}) {
	const { credentials, runtime, registry } = await realRegistry(agentDir);
	const notifications: Notification[] = [];
	const answers = [...(options.answers ?? [])];
	let editorText = options.editorText ?? "";

	const ui = {
		notify: (message: string, type = "info") => notifications.push({ message, type }),
		input: async () => answers.shift(),
		select: async () => answers.shift(),
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
	};

	let rejectProviderId = options.rejectProviderId;

	const ctx = {
		ui,
		mode: "tui" as string,
		cwd: agentDir,
		modelRegistry: registry,
		model: undefined as Model<Api> | undefined,
		isProjectTrusted: () => true,
	};

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const providers = new Map<string, Provider>();

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: (_name: string, registration: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = registration.handler;
		},
		registerProvider: (provider: Provider) => {
			if (provider.id === rejectProviderId) throw new Error(`rejected ${provider.id}`);
			registry.registerProvider(provider);
			providers.set(provider.id, provider);
		},
		unregisterProvider: (id: string) => {
			providers.delete(id);
			registry.unregisterProvider(id);
		},
	};

	await (options.extension ?? createAccountManager)(pi as never);

	return {
		credentials,
		runtime,
		registry,
		notifications,
		providers,
		last: () => notifications[notifications.length - 1],
		editor: () => editorText,
		account: (args: string) => command!(args, ctx),
		emit: (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx),
		setMode: (mode: string) => {
			ctx.mode = mode;
		},
		setModel: (model: Model<Api> | undefined) => {
			ctx.model = model;
		},
		rejectProvider: (id: string | undefined) => {
			rejectProviderId = id;
		},
	};
}
