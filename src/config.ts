import { DEFAULT_OPENROUTER_URL } from "./openrouter";
import { APPROVED_MODEL, DEFAULT_FALLBACK_MODELS, DEFAULT_VISION_MODEL, effectiveModel } from "./policy";

export type Config = {
  telegramBotToken: string;
  telegramApiBase: string;
  // Text classifier: Z.ai GLM 5.3 Flash on OpenRouter. The Jev questionnaire is unchanged.
  openRouterApiKey: string;
  openRouterUrl: string;
  openRouterModel: string;
  // Vision & identity classifier on OpenRouter (replacing Z.AI).
  openRouterVisionModel: string;
  openRouterFallbackModels: string[];
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

function parseFallbackModels(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [...DEFAULT_FALLBACK_MODELS];
  if (trimmed.toLowerCase() === "none") return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const part of trimmed.split(",")) {
    const model = part.trim();
    if (model && !seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return models;
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
    openRouterUrl: process.env.OPENROUTER_URL?.trim() || DEFAULT_OPENROUTER_URL,
    openRouterModel: effectiveModel(process.env.OPENROUTER_MODEL?.trim() || APPROVED_MODEL),
    openRouterVisionModel: effectiveModel(process.env.OPENROUTER_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL),
    openRouterFallbackModels: parseFallbackModels(process.env.OPENROUTER_FALLBACK_MODELS),
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
