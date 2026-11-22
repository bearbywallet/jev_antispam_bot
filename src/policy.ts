// Coupled with the approved classifiers; see README "Policy pin".
// Text, photos, and identity screening use Z.ai GLM 5.3 Flash on OpenRouter.
// The Jev spam questionnaire is unchanged. Fallbacks are `openrouter/free`,
// `openai/gpt-oss-20b:free`, and `openai/gpt-oss-20b`.
export const APPROVED_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_VISION_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_FALLBACK_MODELS = [
  "openrouter/free",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-20b",
] as const;
export const APPROVED_PROMPT_SHA256 = "30876f5586280fae13523212cc3b2cfa400c8fa3c844c85803312893766ee04b";
export function effectiveModel(configured: string): string {
  return configured;
}
