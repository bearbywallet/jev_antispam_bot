// Coupled with the approved classifiers; see README "Policy pin".
// Text goes through the TypeSafe Jev router on OpenRouter; images go to the
// Z.AI GLM vision model. The pin covers the routed endpoint slug, not the
// engine a router happens to serve (routers rotate engines by design).
export const APPROVED_MODEL = "typesafe/jev-router";
export const APPROVED_PROMPT_SHA256 = "44a70ffd349bb1c302c0c5bf433f5c5c00254f0dbbb46da091fa3d46820794bb";
export function effectiveModel(configured: string): string {
  return configured;
}
