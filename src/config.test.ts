import { expect, test } from "bun:test";
import { loadConfig } from "./config";

test("loads required vars with documented defaults and clamps", () => {
  const names = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "ZAI_API_KEY", "SPAM_THRESHOLD", "ZAI_MODEL", "OPENROUTER_MODEL", "CLASSIFIER_TIMEOUT_MS", "OPENROUTER_URL", "ZAI_URL", "TELEGRAM_API_BASE", "DUCKDB_PATH", "SHADOW_MODEL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.TELEGRAM_BOT_TOKEN = "synthetic"; process.env.OPENROUTER_API_KEY = "or-key"; process.env.ZAI_API_KEY = "zai-key";
    expect(loadConfig()).toEqual({
      telegramBotToken: "synthetic",
      telegramApiBase: "https://api.telegram.org",
      openRouterApiKey: "or-key",
      openRouterUrl: "https://openrouter.ai/api/v1",
      openRouterModel: "typesafe/jev-router",
      zaiApiKey: "zai-key",
      zaiUrl: "https://api.z.ai/api/coding/paas/v4",
      zaiModel: "glm-4.6v",
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
    process.env.ZAI_URL = "https://api.z.ai/api/paas/v4"; expect(loadConfig().zaiUrl).toBe("https://api.z.ai/api/paas/v4");
    process.env.ZAI_MODEL = "glm-4.5v"; expect(loadConfig().zaiModel).toBe("glm-4.5v");
    process.env.SHADOW_MODEL = "glm-4.6";
    process.env.SHADOW_TIMEOUT_MS = "45000";
    expect(loadConfig().shadow).toEqual({ model: "glm-4.6", timeoutMs: 45000 });
    delete process.env.SHADOW_MODEL;
    expect(loadConfig().shadow).toBeUndefined();
    delete process.env.ZAI_API_KEY;
    expect(() => loadConfig()).toThrow("ZAI_API_KEY");
    process.env.ZAI_API_KEY = "zai-key";
    delete process.env.OPENROUTER_API_KEY;
    expect(() => loadConfig()).toThrow("OPENROUTER_API_KEY");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
