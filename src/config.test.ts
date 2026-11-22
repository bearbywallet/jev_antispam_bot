import { expect, test } from "bun:test";
import { loadConfig } from "./config";

test("loads required vars with documented defaults and clamps", () => {
  const names = [
    "TELEGRAM_BOT_TOKEN",
    "OPENROUTER_API_KEY",
    "SPAM_THRESHOLD",
    "OPENROUTER_MODEL",
    "OPENROUTER_VISION_MODEL",
    "OPENROUTER_FALLBACK_MODELS",
    "CLASSIFIER_TIMEOUT_MS",
    "OPENROUTER_URL",
    "TELEGRAM_API_BASE",
    "DUCKDB_PATH",
    "SHADOW_MODEL",
    "SHADOW_TIMEOUT_MS",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.TELEGRAM_BOT_TOKEN = "synthetic";
    process.env.OPENROUTER_API_KEY = "or-key";
    expect(loadConfig()).toEqual({
      telegramBotToken: "synthetic",
      telegramApiBase: "https://api.telegram.org",
      openRouterApiKey: "or-key",
      openRouterUrl: "https://openrouter.ai/api/v1",
      openRouterModel: "z-ai/glm-5.3-flash",
      openRouterVisionModel: "z-ai/glm-5.3-flash",
      openRouterFallbackModels: [
        "openrouter/free",
        "openai/gpt-oss-20b:free",
        "openai/gpt-oss-20b",
      ],
      duckdbPath: "./data/antispam.duckdb",
      spamThreshold: 0.81,
      classifierTimeoutMs: 15000,
      shadow: undefined,
    });
    process.env.SPAM_THRESHOLD = "0.5"; expect(loadConfig().spamThreshold).toBe(0.5);
    process.env.SPAM_THRESHOLD = "0.49"; expect(() => loadConfig()).toThrow("SPAM_THRESHOLD");
    process.env.SPAM_THRESHOLD = "1.01"; expect(() => loadConfig()).toThrow("SPAM_THRESHOLD");
    process.env.SPAM_THRESHOLD = "nan"; expect(() => loadConfig()).toThrow("SPAM_THRESHOLD");
    process.env.SPAM_THRESHOLD = "0.9";
    process.env.CLASSIFIER_TIMEOUT_MS = "999"; expect(() => loadConfig()).toThrow("CLASSIFIER_TIMEOUT_MS");
    process.env.CLASSIFIER_TIMEOUT_MS = "30001"; expect(() => loadConfig()).toThrow("CLASSIFIER_TIMEOUT_MS");
    process.env.CLASSIFIER_TIMEOUT_MS = "12345.6"; expect(() => loadConfig()).toThrow("CLASSIFIER_TIMEOUT_MS");
    process.env.CLASSIFIER_TIMEOUT_MS = "20000"; expect(loadConfig().classifierTimeoutMs).toBe(20000);
    process.env.OPENROUTER_URL = "https://openrouter.example/v1";
    expect(loadConfig().openRouterUrl).toBe("https://openrouter.example/v1");
    process.env.OPENROUTER_VISION_MODEL = "nvidia/nemotron-3.5-super-vl";
    expect(loadConfig().openRouterVisionModel).toBe("nvidia/nemotron-3.5-super-vl");
    process.env.OPENROUTER_FALLBACK_MODELS = "openrouter/free, openai/gpt-oss-20b, openrouter/free";
    expect(loadConfig().openRouterFallbackModels).toEqual(["openrouter/free", "openai/gpt-oss-20b"]);
    process.env.OPENROUTER_FALLBACK_MODELS = "none";
    expect(loadConfig().openRouterFallbackModels).toEqual([]);
    process.env.SHADOW_MODEL = "openai/gpt-oss-20b";
    process.env.SHADOW_TIMEOUT_MS = "45000";
    expect(loadConfig().shadow).toEqual({ model: "openai/gpt-oss-20b", timeoutMs: 45000 });
    delete process.env.SHADOW_MODEL;
    expect(loadConfig().shadow).toBeUndefined();
    delete process.env.OPENROUTER_API_KEY;
    expect(() => loadConfig()).toThrow("OPENROUTER_API_KEY");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
