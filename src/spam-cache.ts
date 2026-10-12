import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Message } from "grammy/types";
import { duckMigrate, duckQuery } from "./duck";
import { SPAM_QUESTIONS, type CurrentModerationMessage, type SpamAssessment } from "./spam";

// Source digest invalidates on prompt, projection, enrichment or gate changes.
const policy = createHash("sha256");
for (const file of ["spam.ts", "message.ts", "bot.ts", "profile.ts", "telegram-preview.ts", "personal-posts.ts", "inline-buttons.ts", "spam-cache.ts", "policy.ts"])
  policy.update(readFileSync(new URL(file, import.meta.url)));
export const CACHE_POLICY_REVISION = policy.digest("hex");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cacheEligible(message: Message): boolean {
  if ("sticker" in message) return false;
  const text = "text" in message ? message.text : "caption" in message ? message.caption : undefined;
  if (!text) return false;
  const entities = ("entities" in message ? message.entities : "caption_entities" in message ? message.caption_entities : undefined) ?? [];
  const custom = entities.filter(e => e.type === "custom_emoji");
  // Telegram offsets are UTF-16; replace each custom emoji span by one grapheme.
  let countedText = text;
  for (const e of [...custom].sort((a, b) => b.offset - a.offset)) {
    if (!Number.isInteger(e.offset) || !Number.isInteger(e.length) || e.offset < 0 || e.length < 1 || e.offset + e.length > text.length) return false;
    countedText = countedText.slice(0, e.offset) + "😀" + countedText.slice(e.offset + e.length);
  }
  if ([...segmenter.segment(countedText)].length <= 10) return false;
  // A custom emoji's fallback can contain ordinary letters; it is not body prose.
  const prose = [...segmenter.segment(text)].filter(({ segment, index }) =>
    !entities.some(e => e.type === "custom_emoji" && index < e.offset + e.length && index + segment.length > e.offset)
    && !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)).map(s => s.segment).join("");
  return /[\p{L}\p{N}]/u.test(prose);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}

export function cacheFingerprint(raw: Message, actor: string, input: CurrentModerationMessage,
  historyCount: number, model: string, threshold: number, enrichmentComplete: boolean,
  revision = CACHE_POLICY_REVISION): string | undefined {
  // v1 does not reuse campaign/history or personal-channel/public-destination evidence.
  // Their completeness/freshness cannot currently be proven. Plain ads still hit.
  if (!cacheEligible(raw) || historyCount || !enrichmentComplete || input.senderProfile?.personalChannel
    || input.destinationPreviews?.length) return;
  const { message_id, date, edit_date, ...identity } = raw as Message & { edit_date?: number };
  const serialized = canonical({ revision, model, threshold, actor, chat: raw.chat.id, identity, input });
  if (serialized.length > 100_000) return;
  return createHash("sha256").update(serialized).digest("hex");
}

export function confirmedSpam(assessment: SpamAssessment, threshold: number): boolean {
  return assessment.shouldDelete && Number.isFinite(assessment.probability) && assessment.probability >= threshold
    && assessment.probability <= 1 && assessment.contextProbabilities.length === 0
    && Object.keys(SPAM_QUESTIONS).every(key => {
      const p = assessment.signals[key as keyof typeof SPAM_QUESTIONS];
      return Number.isFinite(p) && p >= 0 && p <= 1;
    });
}

export type SpamCache = Pick<DuckDbSpamCache, "lookup" | "seed">;
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/duck", import.meta.url));
export class DuckDbSpamCache {
  private migration?: Promise<void>;
  private writer: Promise<unknown> = Promise.resolve();
  private active = 0;
  private readonly counters = { hit: 0, miss: 0, error: 0, eviction: 0 };
  constructor(private readonly options: {
    timeoutMs?: number; ttlMs?: number; capacity?: number; revision?: string;
    logger?: Pick<Console, "info">;
  } = {}) {
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 100_000
      || this.ttl < 1 || this.ttl > 86_400_000) throw new Error("Invalid spam cache bounds");
  }
  private get timeout() { return this.options.timeoutMs ?? 250; }
  private get capacity() { return this.options.capacity ?? 10_000; }
  private get ttl() { return this.options.ttlMs ?? 86_400_000; }
  private get revision() { return this.options.revision ?? CACHE_POLICY_REVISION; }
  health() { return { ...this.counters }; }
  async close() { /* The DuckDB connection is shared process-wide; lifecycle.ts closes it. */ }
  async lookup(fingerprint: string): Promise<boolean> {
    const hit = await this.bounded(async () => {
      await this.ensureMigrated();
      const result = await duckQuery("SELECT 1 AS ok FROM spam_verdict_cache WHERE fingerprint=$1 AND revision=$2 AND expires_at > NOW() AND verdict = TRUE", [fingerprint, this.revision]);
      return result.rowCount === 1;
    });
    if (hit !== undefined) this.count(hit ? "hit" : "miss");
    return hit === true;
  }
  async seed(fingerprint: string): Promise<void> {
    await this.bounded(async () => {
      await this.ensureMigrated();
      // DuckDB is single-writer: a promise-chain mutex replaces the advisory lock.
      const run = this.writer.then(async () => {
        const expired = await duckQuery("DELETE FROM spam_verdict_cache WHERE expires_at <= NOW() OR revision <> $1", [this.revision]);
        await duckQuery(
          "INSERT INTO spam_verdict_cache(fingerprint, revision, verdict, expires_at) VALUES ($1,$2,TRUE,NOW()+$3::BIGINT*INTERVAL 1 MILLISECOND) ON CONFLICT (fingerprint) DO NOTHING",
          [fingerprint, this.revision, this.ttl]);
        const pruned = await duckQuery("DELETE FROM spam_verdict_cache WHERE fingerprint IN (SELECT fingerprint FROM spam_verdict_cache ORDER BY expires_at DESC, fingerprint DESC OFFSET $1::INTEGER)", [this.capacity]);
        this.count("eviction", expired.rowCount + pruned.rowCount);
      });
      this.writer = run.catch(() => undefined);
      await run;
      return true;
    });
  }
  private async ensureMigrated() {
    this.migration ??= duckMigrate(MIGRATIONS_DIR).catch(error => { this.migration = undefined; throw error; });
    await this.migration;
  }
  private async bounded<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.active >= 2) { this.count("error"); return; }
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = operation().finally(() => { this.active--; });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cache deadline")), this.timeout);
      })]);
    } catch { this.count("error"); return; }
    finally { clearTimeout(timer); }
  }
  private count(kind: keyof typeof this.counters, amount = 1) {
    this.counters[kind] += amount;
    if (amount) (this.options.logger ?? console).info(JSON.stringify({ event: "spam_cache", ...this.counters }));
  }
}
