import { effectiveModel } from "./policy";
export type Config = {
  telegramBotToken: string;
  telegramApiBase: string;
  // Text classifier: TypeSafe Jev router on OpenRouter.
  openRouterApiKey: string;
  openRouterUrl: string;
  openRouterModel: string;
  // Vision classifier: Z.AI GLM (photos).
  zaiApiKey: string;
  zaiUrl: string;
  zaiModel: string;
  duckdbPath: string;
  spamThreshold: number;
  classifierTimeoutMs: number;
  shadow?: { model: string; timeoutMs: number };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export function loadConfig(): Config {
  const spamThreshold = numberFromEnv("SPAM_THRESHOLD", 0.81);
  if (spamThreshold < 0.5 || spamThreshold > 1) {
    throw new Error("SPAM_THRESHOLD must be between 0.5 and 1");
  }

  const classifierTimeoutMs = numberFromEnv("CLASSIFIER_TIMEOUT_MS", 15_000);
  if (!Number.isInteger(classifierTimeoutMs) || classifierTimeoutMs < 1_000 || classifierTimeoutMs > 30_000) {
    throw new Error("CLASSIFIER_TIMEOUT_MS must be an integer between 1000 and 30000");
  }

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    // Bot API base: must match where the file_id was minted when fetching photos.
    telegramApiBase: process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org",
    openRouterApiKey: required("OPENROUTER_API_KEY"),
    openRouterUrl: process.env.OPENROUTER_URL?.trim() || "https://openrouter.ai/api/v1",
    openRouterModel: effectiveModel(process.env.OPENROUTER_MODEL?.trim() || "typesafe/jev-router"),
    zaiApiKey: required("ZAI_API_KEY"),
    // Z.AI OpenAI-compatible endpoint (coding plan subscription).
    zaiUrl: process.env.ZAI_URL?.trim() || "https://api.z.ai/api/coding/paas/v4",
    zaiModel: effectiveModel(process.env.ZAI_MODEL?.trim() || "glm-4.6v"),
    duckdbPath: process.env.DUCKDB_PATH?.trim() || "./data/antispam.duckdb",
    spamThreshold,
    classifierTimeoutMs,
    // Shadow classifier: logged next to the primary verdict, never deletes.
    shadow: process.env.SHADOW_MODEL?.trim() ? {
      model: process.env.SHADOW_MODEL.trim(),
      timeoutMs: numberFromEnv("SHADOW_TIMEOUT_MS", 30_000),
    } : undefined,
  };
}
