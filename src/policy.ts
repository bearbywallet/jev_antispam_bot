// Coupled with the approved classifiers; see README "Policy pin".
// Text goes through the TypeSafe Jev router on OpenRouter; vision (photos) and
// identity screening go through OpenRouter (`nvidia/nemotron-3.5-super-vl:free`)
// with free-model (`openrouter/free`, `openai/gpt-oss-20b:free`) and
// `openai/gpt-oss-20b` fallbacks.
export const APPROVED_MODEL = "typesafe/jev-router";
export const DEFAULT_VISION_MODEL = "nvidia/nemotron-3.5-super-vl:free";
export const DEFAULT_FALLBACK_MODELS = [
  "openrouter/free",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-20b",
] as const;
export const APPROVED_PROMPT_SHA256 = "30876f5586280fae13523212cc3b2cfa400c8fa3c844c85803312893766ee04b";
export function effectiveModel(configured: string): string {
  return configured;
}
