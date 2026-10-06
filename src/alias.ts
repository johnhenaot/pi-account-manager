import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Account, aliasDisplayName, aliasId, type ProviderId } from "./account.ts";

export function bundledProvider(provider: ProviderId): Provider | undefined {
	return builtinProviders().find((candidate) => candidate.id === provider);
}

export function buildAlias(base: Provider | undefined, account: Account): Provider {
	const id = aliasId(account.provider, account.name);
	if (!base) throw new Error(`provider "${account.provider}" is not available.`);
	if (base.id !== account.provider) throw new Error(`provider "${account.provider}" resolved to "${base.id}".`);
	const oauth = base.auth.oauth;
	if (!oauth) throw new Error(`provider "${account.provider}" has no OAuth flow.`);
	if (base.getModels().length === 0) throw new Error(`provider "${account.provider}" has no models.`);

	const reprovision = (models: readonly Model<Api>[], provider: string) =>
		models.map((model) => ({ ...model, provider }));

	const streamOptions = <T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined => {
		// Pi's Responses adapter recognizes ChatGPT subscription tokens only on the
		// literal `openai` provider. Mirror its payload omissions without changing the
		// alias ID used for credentials, stream attribution, and transcript replay.
		if (
			account.provider !== "openai" || model.api !== "openai-responses" ||
			model.baseUrl !== "https://api.openai.com/v1" ||
			options?.apiKey === undefined || options.apiKey.startsWith("sk-")
		) return options;
		return {
			...options,
			onPayload: async (payload, requestModel) => {
				const params = payload as Record<string, unknown>;
				delete params.max_output_tokens;
				delete params.temperature;
				delete params.prompt_cache_retention;
				delete params.prompt_cache_options;
				// Native Pi applies these omissions before the caller's hook too.
				return options.onPayload?.(payload, requestModel);
			},
		};
	};

	return {
		id,
		name: aliasDisplayName(account.provider, account.name),
		baseUrl: base.baseUrl,
		headers: base.headers,
		// Omitting `apiKey` is the isolation: the alias can only reach its own OAuth token,
		// never the native key or an ambient credential.
		auth: { oauth },
		getModels: () => reprovision(base.getModels(), id),
		filterModels:
			base.filterModels &&
			((models, credential) => {
				const kept = new Set(
					base.filterModels!(reprovision(models, base.id), credential).map((model) => model.id),
				);
				return models.filter((model) => kept.has(model.id));
			}),
		// The model keeps `provider: <alias id>`, which is what makes pi attribute every stream
		// event, message, and session entry to this account.
		stream: (model, context, options) => base.stream(model, context, streamOptions(model, options)),
		streamSimple: (model, context, options) => base.streamSimple(model, context, streamOptions(model, options)),
	};
}
