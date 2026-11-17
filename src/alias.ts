import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelsStoreEntry,
	type Provider,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Account, accountId, PROVIDERS, type ProviderId } from "./account.ts";

export const bundledProvider = (provider: ProviderId): Provider | undefined =>
	builtinProviders().find((candidate) => candidate.id === provider);

const withoutBom = (text: string) => text.replace(/^\uFEFF/, "");

async function readCachedCatalogs(agentDir: string): Promise<Record<string, ModelsStoreEntry | undefined>> {
	try {
		const parsed: unknown = JSON.parse(withoutBom(await readFile(join(agentDir, "models-store.json"), "utf8")));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, ModelsStoreEntry>) : {};
	} catch {
		return {};
	}
}

const offlineRuntimeWithoutCredentials = (agentDir: string): Promise<ModelRuntime> =>
	ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: join(agentDir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		// A full refresh also checks auth, which can run models.json key commands a second time.
		refreshOnCreate: false,
	});

async function restoreCachedCatalog(provider: Provider, cached: ModelsStoreEntry | undefined): Promise<void> {
	try {
		await provider.refreshModels?.({
			stored: cached && structuredClone(cached),
			allowNetwork: false,
			signal: new AbortController().signal,
			baseUrl: provider.baseUrl,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
	} catch {}
}

export async function startupProviders(
	agentDir: string,
	ids: readonly ProviderId[],
): Promise<Map<ProviderId, Provider>> {
	const providers = new Map<ProviderId, Provider>();
	if (ids.length === 0) return providers;
	const runtime = await offlineRuntimeWithoutCredentials(agentDir).catch(() => undefined);
	if (!runtime) return providers;
	const catalogs = await readCachedCatalogs(agentDir);
	for (const id of new Set(ids)) {
		const provider = runtime.getProvider(id);
		if (!provider) continue;
		await restoreCachedCatalog(provider, catalogs[id]);
		providers.set(id, provider);
	}
	return providers;
}

export function buildAlias(base: Provider | undefined, account: Account): Provider {
	const id = accountId(account);
	const oauth = base?.auth.oauth;
	if (!base || !oauth) throw new Error(`provider "${account.provider}" has no OAuth flow.`);

	const reprovision = (models: readonly Model<Api>[], provider: string) =>
		models.map((model) => ({ ...model, provider }));

	const isChatGPTSubscription = (model: Model<Api>, options: StreamOptions | undefined) =>
		account.provider === "openai" &&
		model.api === "openai-responses" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		options?.apiKey !== undefined &&
		!options.apiKey.startsWith("sk-");

	const withoutMidConvoEffort = (model: Model<Api>) => ({
		...model,
		compat: { ...model.compat, supportsMidConvoEffort: false },
	});

	const omitUnsupportedFields =
		(options: StreamOptions | undefined): StreamOptions["onPayload"] =>
		async (payload, requestModel) => {
			const params = payload as Record<string, unknown>;
			delete params.max_output_tokens;
			delete params.temperature;
			delete params.prompt_cache_retention;
			delete params.prompt_cache_options;
			return options?.onPayload?.(payload, requestModel);
		};

	const streamRequest = <T extends StreamOptions | undefined>(model: Model<Api>, options: T) => {
		if (account.provider === "anthropic" && model.api === "anthropic-messages") {
			// Pi 49fe0a2 makes this the default for every provider; remove once MIN_PI includes it.
			if (
				(model as Model<"anthropic-messages">).compat?.supportsMessageThreads === undefined &&
				model.baseUrl.includes("api.anthropic.com")
			) {
				model = { ...model, compat: { ...model.compat, supportsMessageThreads: true } };
			}
			// Keeps each account's thread and fallback state apart. Shortcut: Pi's session cleanup misses
			// these scoped ids; Pi's 10k caps bound them. Track the ids if that ever matters.
			if (options?.sessionId) options = { ...options, sessionId: `${options.sessionId}:${id}` };
		}
		return isChatGPTSubscription(model, options)
			? {
					model: withoutMidConvoEffort(model),
					options: { ...options, onPayload: omitUnsupportedFields(options) } satisfies T,
				}
			: { model, options };
	};

	return {
		id,
		name: `${PROVIDERS[account.provider]} (${account.name})`,
		baseUrl: base.baseUrl,
		headers: base.headers,
		// Omitting `apiKey` is the isolation: the alias can only reach its own OAuth token,
		// never the native key or an ambient credential. Exception (documented in the README):
		// headers that models.json attaches to the native provider's OAuth still apply.
		auth: { oauth },
		getModels: () => reprovision(base.getModels(), id),
		filterModels:
			base.filterModels &&
			((models, credential) => {
				const kept = new Set(base.filterModels!(reprovision(models, base.id), credential).map((model) => model.id));
				return models.filter((model) => kept.has(model.id));
			}),
		// The model keeps `provider: <alias id>`, which is what makes pi attribute every stream
		// event, message, and session entry to this account.
		stream: (model, context, options) => {
			const request = streamRequest(model, options);
			return base.stream(request.model, context, request.options);
		},
		streamSimple: (model, context, options) => {
			const request = streamRequest(model, options);
			return base.streamSimple(request.model, context, request.options);
		},
	};
}
