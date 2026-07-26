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
 * be reached by module path. ESM caches by resolved path, so this is the same object pi
 * itself reads. Each alias inherits whatever default its native provider has, which is
 * why nothing here hardcodes a model ID.
 *
 * Best effort by design: if pi moves the module, aliases simply keep the old message.
 */
type DefaultModelMap = Record<string, string>;

const CANDIDATE_PATHS = [
	// npm/node layout, and the compiled-binary layout where dist/ is flattened.
	["dist", "core", "model-resolver.js"],
	["core", "model-resolver.js"],
];

let loaded: DefaultModelMap | null | undefined;

async function defaultModelMap(): Promise<DefaultModelMap | null> {
	if (loaded !== undefined) return loaded;
	loaded = null;
	for (const segments of CANDIDATE_PATHS) {
		try {
			const specifier = pathToFileURL(join(getPackageDir(), ...segments)).href;
			const module = (await import(specifier)) as { defaultModelPerProvider?: unknown };
			const map = module.defaultModelPerProvider;
			if (map && typeof map === "object") {
				loaded = map as DefaultModelMap;
				break;
			}
		} catch {
			// Try the next layout.
		}
	}
	return loaded;
}

/** Give `aliasId` the same post-login default model as its native provider. */
export async function adoptNativeDefaultModel(provider: ProviderId, aliasId: string): Promise<void> {
	const map = await defaultModelMap();
	const nativeDefault = map?.[provider];
	if (!map || typeof nativeDefault !== "string") return;
	map[aliasId] ??= nativeDefault;
}

export async function forgetDefaultModel(aliasId: string): Promise<void> {
	const map = await defaultModelMap();
	if (map) delete map[aliasId];
}
