import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { ProviderId } from "./account.ts";

/**
 * Pi auto-selects a model after `/login` only for provider IDs in its own
 * `defaultModelPerProvider` map, so an alias ID lands on "no default model is configured"
 * instead. That map is mutable but not exported, hence the reach by module path.
 */
type DefaultModelMap = Record<string, string>;

// On globalThis because `/reload` may re-evaluate this module, while the host map it
// tracks outlives that.
const INSTALLED = Symbol.for("pi-account-manager.installedDefaultModels");
const installed = ((globalThis as Record<symbol, unknown>)[INSTALLED] ??= new Map<string, string>()) as Map<
	string,
	string
>;

export type Resolver = ((specifier: string) => string) | undefined;

// Detached so callers can substitute it, and absent where import.meta is stubbed.
const moduleGraphResolver: Resolver =
	typeof import.meta.resolve === "function" ? (specifier) => import.meta.resolve(specifier) : undefined;

/**
 * `getPackageDir()` returns `$PI_PACKAGE_DIR` verbatim, and this string becomes an
 * executable module specifier, so the module graph is preferred — pi aliases the bare
 * specifier to the running pi's own dist. The fallback serves only runtimes without
 * `import.meta.resolve`, such as vitest's SSR transform.
 */
export function modelResolverSpecifier(resolve: Resolver = moduleGraphResolver): string {
	if (resolve) {
		try {
			return new URL("core/model-resolver.js", resolve("@earendil-works/pi-coding-agent")).href;
		} catch {}
	}
	return pathToFileURL(join(getPackageDir(), "dist", "core", "model-resolver.js")).href;
}

// The promise is memoized rather than its value: index.ts adopts every account
// concurrently, and memoizing the value lets later callers see the still-loading state
// and skip their write.
let pending: Promise<DefaultModelMap | null> | undefined;

function defaultModelMap(): Promise<DefaultModelMap | null> {
	pending ??= (async () => {
		try {
			const module = (await import(modelResolverSpecifier())) as { defaultModelPerProvider?: unknown };
			const map = module.defaultModelPerProvider;
			if (map && typeof map === "object") return map as DefaultModelMap;
		} catch {
			// Pi's internals moved; aliases keep pi's "use /model to select a model" message.
		}
		return null;
	})();
	return pending;
}

/**
 * Validated against the alias catalog: a models.json overlay can leave the effective
 * provider without its native default, and pi then reports that default as unavailable
 * instead of selecting anything.
 */
export async function adoptNativeDefaultModel(provider: ProviderId, alias: Provider): Promise<void> {
	const map = await defaultModelMap();
	const nativeDefault = map?.[provider];
	if (!map || typeof nativeDefault !== "string") return;

	const ours = installed.get(alias.id);
	if (alias.id in map && map[alias.id] !== ours) return;

	if (!alias.getModels().some((model) => model.id === nativeDefault)) {
		if (ours !== undefined) {
			delete map[alias.id];
			installed.delete(alias.id);
		}
		return;
	}
	map[alias.id] = nativeDefault;
	installed.set(alias.id, nativeDefault);
}

/** Without this, a provider later taking the ID inherits a default it may not offer. */
export async function releaseDefaultModel(aliasId: string): Promise<void> {
	const ourValue = installed.get(aliasId);
	if (ourValue === undefined) return;
	installed.delete(aliasId);
	const map = await defaultModelMap();
	// Only if the value is still ours: a provider that took over the ID may have set its own.
	if (map && map[aliasId] === ourValue) delete map[aliasId];
}
