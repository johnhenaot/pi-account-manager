import type { Provider } from "@earendil-works/pi-ai";
import { type Account, aliasDisplayName, aliasId } from "./core.js";

/**
 * Build an OAuth-only alias of a native provider (spec §5).
 * Credentials isolate automatically: pi's credential store keys by Provider.id,
 * and the alias id is the account's alias id.
 */
export function makeAlias(
	base: Provider | undefined,
	account: Account,
): Provider {
	if (!base)
		throw new Error(`native provider "${account.provider}" is not available`);
	const oauth = base.auth.oauth;
	if (!oauth)
		throw new Error(`provider "${account.provider}" has no OAuth flow`);
	if (base.getModels().length === 0) {
		throw new Error(
			`provider "${account.provider}" has an empty model catalog`,
		);
	}
	const id = aliasId(account);
	return {
		id,
		name: aliasDisplayName(account),
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: { oauth }, // OAuth only: no apiKey member means no env-var or ambient fallback
		getModels: () => base.getModels().map((m) => ({ ...m, provider: id })),
		...(base.filterModels
			? { filterModels: base.filterModels.bind(base) }
			: {}),
		stream: (model, context, options) =>
			base.stream(model as never, context, options),
		streamSimple: (model, context, options) =>
			base.streamSimple(model as never, context, options),
	};
}
