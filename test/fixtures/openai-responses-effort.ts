import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { type OpenAIResponsesOptions, stream as stableStream } from "@earendil-works/pi-ai/api/openai-responses";

/**
 * Bounded simulation of earendil-works/pi#10930 at
 * b45e0ebcc5ae2fc42a6f2f23104d10e656e6bedb (not shipped in our pinned Pi 1.2.0).
 * The stable adapter builds/sends the real request through injected fetch; this
 * hook adds only the new current-effort item and medium request-effort behavior
 * before the caller's hook. It does not simulate history replay or a live server.
 * For verification against the actual upstream adapter, replace this module via
 * Vitest's resolve.alias with that checkout's openai-responses.ts adapter.
 */
export type EffortModel = Model<"openai-responses"> & {
	compat?: Model<"openai-responses">["compat"] & { supportsMidConvoEffort?: boolean };
};

// Same exemption and effort mapping as upstream getConfigurationUpdateEffort.
function configurationUpdateEffort(model: EffortModel, options?: OpenAIResponsesOptions): string | undefined {
	if (
		!model.compat?.supportsMidConvoEffort || !options?.reasoningEffort ||
		(model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" &&
			options.apiKey !== undefined && !options.apiKey.startsWith("sk-"))
	) return undefined;
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

export const stream: typeof stableStream = (model, context, options) => {
	const effort = configurationUpdateEffort(model, options);
	return stableStream(model, context, {
		...options,
		onPayload: (payload, requestModel) => {
			if (effort !== undefined) {
				const params = payload as { input: unknown[]; reasoning?: { effort: string } };
				params.input.push({ type: "configuration_update", reasoning: { effort } });
				if (params.reasoning) params.reasoning.effort = "medium";
			}
			return options?.onPayload?.(payload, requestModel);
		},
	});
};

export const streamSimple = (model: Model<"openai-responses">, context: TranscriptContext, options?: SimpleStreamOptions) => {
	const clamped = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, { ...options, reasoningEffort: clamped === "off" ? undefined : clamped });
};
