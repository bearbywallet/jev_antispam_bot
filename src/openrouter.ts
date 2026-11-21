export const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const MAX_OPENROUTER_MODELS_PER_REQUEST = 3;
export const MAX_FALLBACK_HTTP_ATTEMPTS = 4;

export type FallbackErrorKind = "http_400" | "http_other" | "parse" | "network";

export class FallbackAttemptError extends Error {
  constructor(
    public readonly kind: FallbackErrorKind,
    message: string,
    public readonly servedModel?: string,
    public readonly causeError?: unknown,
  ) {
    super(message);
    this.name = "FallbackAttemptError";
  }
}

export function isTextOnlyModel(model: string): boolean {
  return /^openai\/gpt-oss-/i.test(model.trim());
}

/**
 * Deduplicates primary + fallback models in priority order and filters out
 * text-only endpoints when the request carries image inputs.
 */
export function resolveModelChain(
  primary: string,
  fallbackModels: readonly string[] = [],
  requiresVision = false,
): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const raw of [primary, ...fallbackModels]) {
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    if (requiresVision && isTextOnlyModel(model)) continue;
    seen.add(model);
    chain.push(model);
  }
  return chain;
}

/** Strips an optional <think> trace and markdown JSON code fences. */
export function extractJsonText(content: string): string {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = withoutThink.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : withoutThink;
}

function unwrapAttemptError(error: unknown): never {
  if (error instanceof FallbackAttemptError && error.causeError instanceof Error) {
    throw error.causeError;
  }
  throw error instanceof Error ? error : new Error("Classifier fallback exhausted");
}

/**
 * Executes an OpenRouter request across batches of up to 3 models (`models`
 * parameter limit on OpenRouter). Falls through remaining batches on HTTP
 * errors, network failures, HTTP 400 (`response_format` fallback), or invalid
 * JSON from a single served model.
 */
export async function runOpenRouterFallback<T>(
  candidates: readonly string[],
  execute: (batch: string[], useJsonFormat: boolean) => Promise<T>,
): Promise<T> {
  if (candidates.length === 0) {
    throw new Error("No classifier models configured");
  }
  if (candidates.length === 1) {
    try {
      return await execute([candidates[0]!], true);
    } catch (error) {
      unwrapAttemptError(error);
    }
  }

  let remaining = [...candidates];
  let attempts = 0;
  let lastError: unknown;

  while (remaining.length > 0 && attempts < MAX_FALLBACK_HTTP_ATTEMPTS) {
    const batch = remaining.slice(0, MAX_OPENROUTER_MODELS_PER_REQUEST);
    attempts++;
    try {
      return await execute(batch, true);
    } catch (error) {
      lastError = error;
      if (!(error instanceof FallbackAttemptError)) {
        throw error;
      }
      if (error.kind === "http_400") {
        if (attempts < MAX_FALLBACK_HTTP_ATTEMPTS) {
          attempts++;
          try {
            return await execute(batch, false);
          } catch (retryError) {
            lastError = retryError;
            if (!(retryError instanceof FallbackAttemptError)) {
              throw retryError;
            }
          }
        }
        remaining = remaining.slice(batch.length);
        continue;
      }
      if (error.kind === "parse" && batch.length > 1) {
        const served = error.servedModel?.trim();
        const failedIndex = served
          ? remaining.findIndex(
              (m) => m === served || m.replace(/:free$/i, "") === served.replace(/:free$/i, ""),
            )
          : -1;
        const removeIndex =
          batch[0] === "openrouter/free"
            ? 0
            : failedIndex >= 0 && failedIndex < batch.length
              ? failedIndex
              : 0;
        remaining = [...remaining.slice(0, removeIndex), ...remaining.slice(removeIndex + 1)];
        continue;
      }
      remaining = remaining.slice(batch.length);
    }
  }

  unwrapAttemptError(lastError);
}
