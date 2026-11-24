import { join } from "node:path";
import {
	type Api,
	InMemoryCredentialStore,
	type Model,
	type Provider,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Account, accountId, PROVIDERS, type ProviderId } from "./account.ts";

export const bundledProvider = (provider: ProviderId): Provider | undefined =>
	builtinProviders().find((candidate) => candidate.id === provider);

export async function startupProviders(agentDir: string, ids: readonly ProviderId[]) {
	if (ids.length === 0) return;
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	}).catch(() => undefined);
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
		if (account.provider === "anthropic" && model.api === "anthropic-messages" && options?.sessionId) {
			options = { ...options, sessionId: `${options.sessionId}:${id}` };
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
		auth: { oauth },
		getModels: () => reprovision(base.getModels(), id),
		filterModels:
			base.filterModels &&
			((models, credential) => {
				const kept = new Set(base.filterModels!(reprovision(models, base.id), credential).map((model) => model.id));
				return models.filter((model) => kept.has(model.id));
			}),
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
