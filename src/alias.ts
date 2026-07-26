/**
 * Alias providers: one pi provider per named account, wrapping a native provider.
 *
 * An alias exposes the native model catalog under its own provider ID, so pi keeps
 * its OAuth credential separate and attributes its usage separately, while requests
 * still run through the native provider's own stream implementation.
 */

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Account, aliasDisplayName, aliasId, type ProviderId } from "./accounts.ts";

/** Pi's exact bundled provider factories, used for the pre-session bootstrap. */
export function bundledProvider(provider: ProviderId): Provider | undefined {
	return builtinProviders().find((candidate) => candidate.id === provider);
}

/**
 * Build the alias provider for `account` from its native `base`.
 *
 * Throws if the base cannot back an alias that satisfies the design: it must exist,
 * offer OAuth, and have models. The alias exposes OAuth only, so it can never reach
 * a native API key or ambient credential.
 */
export function buildAlias(base: Provider | undefined, account: Account): Provider {
	const id = aliasId(account.provider, account.name);
	if (!base) throw new Error(`provider "${account.provider}" is not available.`);
	if (base.id !== account.provider) throw new Error(`provider "${account.provider}" resolved to "${base.id}".`);
	const oauth = base.auth.oauth;
	if (!oauth) throw new Error(`provider "${account.provider}" has no OAuth flow.`);
	if (base.getModels().length === 0) throw new Error(`provider "${account.provider}" has no models.`);

	const reprovision = (models: readonly Model<Api>[], provider: string) =>
		models.map((model) => ({ ...model, provider }));

	return {
		id,
		name: aliasDisplayName(account.provider, account.name),
		baseUrl: base.baseUrl,
		headers: base.headers,
		// OAuth only, keyed by the alias ID: no path back to the native provider's
		// credential, API key environment variable, or ambient authentication.
		auth: { oauth },
		// Delegated live, so a native catalog change is visible without rebuilding.
		getModels: () => reprovision(base.getModels(), id),
		filterModels:
			base.filterModels &&
			((models, credential) => {
				const kept = new Set(
					base.filterModels!(reprovision(models, base.id), credential).map((model) => model.id),
				);
				return models.filter((model) => kept.has(model.id));
			}),
		// The model keeps `provider: <alias id>`, so every stream event and the
		// finalized assistant message are attributed to this account.
		stream: (model, context, options) => base.stream(model, context, options),
		streamSimple: (model, context, options) => base.streamSimple(model, context, options),
	};
}
