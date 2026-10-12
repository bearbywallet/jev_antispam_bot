import { fileURLToPath } from "node:url";
import { duckMigrate, duckQuery } from "./duck";
import type { SpamAssessment } from "./spam";

// Opt-in (TRAINING_CAPTURE=true): stores the exact classifier request (message text, context and
// sender-profile text included) plus its answers, to distill a self-hosted model. Never
// stores sender IDs. Rows expire after retentionDays and are capped at maxRows.
export type TrainingCapture = Pick<DuckDbTrainingCapture, "record">;
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/duck", import.meta.url));
export class DuckDbTrainingCapture {
  private migration?: Promise<void>;
  private inFlight = 0;
  private lastPrune = 0;
  readonly counters = { stored: 0, dropped: 0, failed: 0 };
  constructor(private readonly options: { retentionDays?: number; maxRows?: number } = {}) {}

  record(chatId: number, messageId: number, request: unknown, answers: unknown, assessment: SpamAssessment): void {
    // Drop rather than queue under load; training data is a sample, not a ledger.
    if (this.inFlight >= 4) { this.counters.dropped++; return; }
    this.inFlight++;
    void this.insert(chatId, messageId, request, answers, assessment)
      .then(() => { this.counters.stored++; }, () => { this.counters.failed++; })
      .finally(() => { this.inFlight--; });
  }

  async close() { /* The DuckDB connection is shared process-wide; lifecycle.ts closes it. */ }

  private async insert(chatId: number, messageId: number, request: unknown, answers: unknown, a: SpamAssessment) {
    this.migration ??= duckMigrate(MIGRATIONS_DIR).catch((error) => { this.migration = undefined; throw error; });
    await this.migration;
    await duckQuery(
      "INSERT INTO training_samples(chat_id, message_id, model, should_delete, probability, strongest_signal, request, answers) VALUES ($1::BIGINT,$2::BIGINT,$3,$4,$5::DOUBLE,$6,$7::JSON,$8::JSON)",
      [chatId, messageId, a.model, a.shouldDelete, a.probability, a.strongestSignal, JSON.stringify(request), JSON.stringify(answers)]);
    if (Date.now() - this.lastPrune < 3_600_000) return;
    this.lastPrune = Date.now();
    await duckQuery("DELETE FROM training_samples WHERE created_at < NOW() - $1::INTEGER * INTERVAL 1 DAY", [this.options.retentionDays ?? 30]);
    await duckQuery("DELETE FROM training_samples WHERE id <= COALESCE((SELECT MIN(id) FROM (SELECT id FROM training_samples ORDER BY id DESC LIMIT 1 OFFSET $1::INTEGER)), 0)", [this.options.maxRows ?? 200_000]);
  }
}
