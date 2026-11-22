import { trackHandlers, drainBot } from "./lifecycle";
import { DuckDbDeletionAudit } from "./audit-outbox";
import { CACHE_POLICY_REVISION } from "./spam-cache";
import { APPROVED_MODEL, APPROVED_PROMPT_SHA256, effectiveModel } from "./policy";
import { DuckDbSpamCache } from "./spam-cache";
import { Bot } from "grammy";
import { registerBotHandlers } from "./bot";
import { registerIdentityScreening, probabilityRequest, AVATAR_COMPARE_PROMPT, AVATAR_SPAM_PROMPT, IDENTITY_TEXT_PROMPT } from "./identity";
import { AdminCache } from "./admin-cache";
import { SenderProfileCache } from "./profile";
import { loadConfig } from "./config";
import { closeDuck } from "./duck";
import { JevSpamClassifier } from "./spam";
import { createStatsRecorder } from "./stats";
import { DuckDbTrainingCapture } from "./training-capture";

const config = loadConfig();
if (effectiveModel(config.openRouterModel) === APPROVED_MODEL && config.spamThreshold !== 0.81) {
  throw new Error("Approved policy requires SPAM_THRESHOLD=0.81");
}
const bot = new Bot(config.telegramBotToken);
const drainHandlers = trackHandlers(bot);
const deletionAudit = new DuckDbDeletionAudit(bot.api, { logger: (line) => console.info(line) });
await deletionAudit.initialize();
deletionAudit.start();
const auditHealthTimer = setInterval(() => {
  void deletionAudit.summary().then(summary => console.info(JSON.stringify({ event: "deletion_audit_health", ...summary, process: deletionAudit.health() })))
    .catch(() => console.error(JSON.stringify({ event: "deletion_audit_health", outcome: "unavailable" })));
}, 60_000);
auditHealthTimer.unref();
const stats = createStatsRecorder();
const spamCache = process.env.SPAM_CACHE_ENABLED !== "false" ? new DuckDbSpamCache() : undefined;
const trainingCapture = process.env.TRAINING_CAPTURE === "true"
  ? new DuckDbTrainingCapture({ retentionDays: Number(process.env.TRAINING_CAPTURE_DAYS || 30) }) : undefined;
const classifier = new JevSpamClassifier(config.openRouterApiKey, {
  model: config.openRouterModel,
  fallbackModels: config.openRouterFallbackModels,
  threshold: config.spamThreshold,
  timeoutMs: config.classifierTimeoutMs,
  url: config.openRouterUrl,
});
// Photos carry the image to a vision-capable model on OpenRouter (with free-model + gpt-oss-20b fallbacks).
const visionClassifier = new JevSpamClassifier(config.openRouterApiKey, {
  model: config.openRouterVisionModel,
  fallbackModels: config.openRouterFallbackModels,
  threshold: config.spamThreshold,
  timeoutMs: config.classifierTimeoutMs,
  url: config.openRouterUrl,
});
const shadowClassifier = config.shadow && new JevSpamClassifier(config.openRouterApiKey, {
  model: config.shadow.model,
  threshold: config.spamThreshold,
  timeoutMs: config.shadow.timeoutMs,
  url: config.openRouterUrl,
});

// Vision attachment: photos are fetched from the Bot API and passed as base64 data URLs.
const imageLoader = async (fileId: string): Promise<string> => {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("file_path missing");
  const url = `${config.telegramApiBase}/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`photo fetch failed with HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > 6 * 1024 * 1024) throw new Error("photo exceeds 6 MB");
  const mime = file.file_path.endsWith(".jpg") || file.file_path.endsWith(".jpeg") ? "image/jpeg"
    : file.file_path.endsWith(".png") ? "image/png" : file.file_path.endsWith(".webp") ? "image/webp" : "application/octet-stream";
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
};

registerBotHandlers(bot, {
  classifier,
  visionClassifier,
  shadowClassifier,
  trainingCapture,
  deletionAudit,
  model: config.openRouterModel,
  visionModel: config.openRouterVisionModel,
  visionFallbackModels: config.openRouterFallbackModels,
  stats,
  spamCache,
  imageLoader,
  spamThreshold: config.spamThreshold,
  banSpammers: process.env.BAN_SPAMMERS !== "false",
});

// Identity screening: joins, renames, admin/support impersonation, promo profiles, spam avatars.
// Uses OpenRouter vision/text model with free-model + gpt-oss-20b fallbacks.
if (process.env.IDENTITY_SCREENING !== "false") {
  const admins = new AdminCache();
  const profiles = new SenderProfileCache();
  const probability = (system: string, user: string, image?: string, images?: string[]) => probabilityRequest(
    fetch, config.openRouterUrl, config.openRouterApiKey, {
      model: config.openRouterVisionModel,
      fallbackModels: config.openRouterFallbackModels,
      system,
      user,
      ...(image ? { image } : {}),
      ...(images ? { images } : {}),
    });
  registerIdentityScreening(bot, {
    admins,
    profiles,
    imageLoader,
    threshold: config.spamThreshold,
    models: {
      promoProbability: (evidence) => probability(IDENTITY_TEXT_PROMPT, evidence),
      avatarSpamProbability: (dataUrl) => probability(AVATAR_SPAM_PROMPT, "Assess this profile photo.", dataUrl),
      avatarImitationProbability: (adminDataUrl, memberDataUrl) => probability(
        AVATAR_COMPARE_PROMPT,
        "First image is the admin, second image is the member. Does the member impersonate them?",
        undefined,
        [adminDataUrl, memberDataUrl],
      ),
    },
    logger: console,
  });
}

let polling: Promise<void> = Promise.resolve();
let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      console.info(JSON.stringify({ event: "bot_stopping", signal, ...stats.health() }));
      await drainBot(bot, polling, drainHandlers);
      clearInterval(auditHealthTimer);
      await deletionAudit.close();
      await spamCache?.close();
      await trainingCapture?.close();
      await stats.stop();
      await closeDuck();
      console.info(JSON.stringify({ event: "bot_stopped", ...stats.health() }));
    })();
  }
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

console.info(JSON.stringify({
  event: "bot_starting",
  model: config.openRouterModel,
  visionModel: config.openRouterVisionModel,
  fallbackModels: config.openRouterFallbackModels,
  threshold: config.spamThreshold,
  cachePolicyRevision: CACHE_POLICY_REVISION,
  approvedPromptSha256: effectiveModel(config.openRouterModel) === APPROVED_MODEL ? APPROVED_PROMPT_SHA256 : null,
  deletionAuditEnabled: true,
  statsEnabled: true,
  spamCacheEnabled: Boolean(spamCache),
  shadowModel: config.shadow?.model ?? null,
  trainingCapture: Boolean(trainingCapture),
  duckdbPath: config.duckdbPath,
}));
try {
  polling = bot.start({
    allowed_updates: ["message", "edited_message", "my_chat_member", "chat_member"],
    onStart: ({ username }) => console.info(JSON.stringify({ event: "bot_started", username })),
  });
  await polling;
} finally {
  if (shutdownPromise) await shutdownPromise;
  else { await drainHandlers(); clearInterval(auditHealthTimer); await deletionAudit.close(); await spamCache?.close(); await trainingCapture?.close(); await stats.stop(); await closeDuck(); }
}
