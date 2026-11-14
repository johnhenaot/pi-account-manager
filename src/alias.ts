import { createHash } from "node:crypto";
import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { cleanupSessionResources, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Account, accountId, type ProviderId, PROVIDERS } from "./account.ts";

const threadSessions = new Map<string, string>();
let unregisterThreadCleanup: (() => void) | undefined;

const cleanupThreadSessions = (sessionId?: string) => {
	if (!sessionId) {
		threadSessions.clear();
		return;
	}
	for (const [scopedId, parentId] of threadSessions) {
		if (parentId !== sessionId) continue;
		threadSessions.delete(scopedId);
		cleanupSessionResources(scopedId);
	}
};

export function disposeThreadSessions(): void {
	unregisterThreadCleanup?.();
	unregisterThreadCleanup = undefined;
	threadSessions.clear();
}

function threadSession(sessionId: string, provider: string, apiKey: string): string {
	unregisterThreadCleanup ??= registerSessionResourceCleanup(cleanupThreadSessions);
	const scopedId = `pi-account-manager:${createHash("sha256")
		.update(JSON.stringify([sessionId, provider, apiKey])).digest("hex")}`;
	threadSessions.delete(scopedId);
	threadSessions.set(scopedId, sessionId);
	if (threadSessions.size > 1000) {
		const oldest = threadSessions.keys().next().value!;
		threadSessions.delete(oldest);
		try {
			cleanupSessionResources(oldest);
		} catch {
			// Another session-resource cleanup failed; never fail the request over eviction.
		}
	}
	return scopedId;
}

export const bundledProvider = (provider: ProviderId): Provider | undefined =>
	builtinProviders().find((candidate) => candidate.id === provider);

export function buildAlias(base: Provider | undefined, account: Account): Provider {
	const id = accountId(account);
	const oauth = base?.auth.oauth;
	if (!base || !oauth) throw new Error(`provider "${account.provider}" has no OAuth flow.`);

	const reprovision = (models: readonly Model<Api>[], provider: string) =>
		models.map((model) => ({ ...model, provider }));

	const isChatGPTSubscription = (model: Model<Api>, options: StreamOptions | undefined) =>
		account.provider === "openai" && model.api === "openai-responses" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		options?.apiKey !== undefined && !options.apiKey.startsWith("sk-");

	const withoutMidConvoEffort = (model: Model<Api>) => ({
		...model,
		compat: { ...model.compat, supportsMidConvoEffort: false },
	});

	const omitUnsupportedFields = (options: StreamOptions | undefined): StreamOptions["onPayload"] =>
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
			if ((model as Model<"anthropic-messages">).compat?.supportsMessageThreads === undefined &&
				model.baseUrl.includes("api.anthropic.com")) {
				model = { ...model, compat: { ...model.compat, supportsMessageThreads: true } };
			}
			if (options?.sessionId && options.apiKey) {
				options = { ...options, sessionId: threadSession(options.sessionId, id, options.apiKey) };
			}
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
				const kept = new Set(
					base.filterModels!(reprovision(models, base.id), credential).map((model) => model.id),
				);
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
