import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ProviderId } from "./account.ts";

/**
 * After `/login`, pi auto-selects a model only for provider IDs present in its own
 * `defaultModelPerProvider` map, and shows an error for anything else. An alias ID is
 * never in that map, so signing in to a named account on a profile with no other model
 * ends in "no default model is configured" instead of a selected model.
 *
 * The map is a mutable object, but it is not on pi's public export surface, so it has to
 * be reached by module path. Each alias inherits whatever default its native provider
 * has, which is why nothing here hardcodes a model ID.
 *
 * Best effort by design: if pi moves the module, aliases simply keep the old message.
 */
type DefaultModelMap = Record<string, string>;

/**
 * Entries this extension added, so removal never deletes one that predated it. Keyed on
 * globalThis because `/reload` re-runs the factory and may re-evaluate this module, while
 * the map being mutated belongs to the host and outlives both.
 */
const INSTALLED = Symbol.for("pi-account-manager.installedDefaultModels");
const installed = ((globalThis as Record<symbol, unknown>)[INSTALLED] ??= new Set<string>()) as Set<string>;

export type Resolver = ((specifier: string) => string) | undefined;

/** Detached so callers can substitute it; absent under bundlers that stub import.meta. */
const moduleGraphResolver: Resolver =
	typeof import.meta.resolve === "function" ? (specifier) => import.meta.resolve(specifier) : undefined;

/**
 * Prefers the module graph over `getPackageDir()`, which returns `$PI_PACKAGE_DIR`
 * verbatim — this string becomes an executable module specifier, so it must not be
 * environment-controlled. Pi aliases the bare specifier to the running pi's own dist, so
 * the import lands on the same module instance pi reads even when the extension has its
 * own copy of the package installed.
 *
 * The `getPackageDir()` fallback exists only for runtimes without `import.meta.resolve`
 * (notably vitest's SSR transform); pi itself always takes the first branch.
 */
export function modelResolverSpecifier(resolve: Resolver = moduleGraphResolver): string {
	if (resolve) {
		try {
			return new URL("core/model-resolver.js", resolve("@earendil-works/pi-coding-agent")).href;
		} catch {
			// Fall through to the package-directory fallback.
		}
	}
	return pathToFileURL(join(getPackageDir(), "dist", "core", "model-resolver.js")).href;
}

// Memoize the promise, not the resolved value: index.ts adopts every account
// concurrently, and memoizing the value lets later callers observe the still-loading
// state and skip their write.
let pending: Promise<DefaultModelMap | null> | undefined;

function defaultModelMap(): Promise<DefaultModelMap | null> {
	pending ??= (async () => {
		try {
			const module = (await import(modelResolverSpecifier())) as { defaultModelPerProvider?: unknown };
			const map = module.defaultModelPerProvider;
			if (map && typeof map === "object") return map as DefaultModelMap;
		} catch {
			// Pi's internals moved. Aliases keep pi's "use /model to select a model" message.
		}
		return null;
	})();
	return pending;
}

/** Give `aliasId` the same post-login default model as its native provider. */
export async function adoptNativeDefaultModel(provider: ProviderId, aliasId: string): Promise<void> {
	const map = await defaultModelMap();
	const nativeDefault = map?.[provider];
	if (!map || typeof nativeDefault !== "string") return;
	// An existing entry is either ours already or predates us; either way, leave it.
	if (aliasId in map) return;
	map[aliasId] = nativeDefault;
	installed.add(aliasId);
}

/**
 * Drop the entry once this extension stops owning the alias ID. Without this, a provider
 * that later takes the same ID would inherit our default and pi would try to select a
 * model that provider may not offer.
 */
export async function releaseDefaultModel(aliasId: string): Promise<void> {
	if (!installed.delete(aliasId)) return;
	const map = await defaultModelMap();
	if (map) delete map[aliasId];
}
