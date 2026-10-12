import { fileURLToPath } from "node:url";

import { duckMigrate, duckQuery } from "./duck";
const DEDUPE_RETENTION_DAYS = 90;

export type ChatId = number | bigint | string;

export type ChatObservation = {
  chatId: ChatId;
  seenAt?: Date;
  chatType?: string;
  membershipActive?: boolean;
};

export type DeletionObservation = {
  chatId: ChatId;
  messageId: number | bigint | string;
  deletedAt?: Date;
  source?: "jev" | "cache";
};

export type ClassificationAttemptObservation = {
  chatId: ChatId;
  messageId: number | bigint | string;
  updateId: number | bigint | string;
  attemptedAt?: Date;
};

type PendingChat = {
  chatId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  chatType: string | null;
  membershipActive: boolean | null;
};

type PendingDeletion = {
  chatId: string;
  messageId: string;
  deletedAt: string;
  source?: "jev" | "cache";
};

type PendingClassificationAttempt = {
  chatId: string;
  messageId: string;
  updateId: string;
  attemptedAt: string;
};

export type StatsBatch = {
  chats: PendingChat[];
  deletions: PendingDeletion[];
  classificationAttempts: PendingClassificationAttempt[];
};

export interface StatsStore {
  writeBatch(batch: StatsBatch): Promise<void>;
  close(): Promise<void>;
}

export interface StatsRecorder {
  observeChat(observation: ChatObservation): void;
  recordClassificationAttempt(observation: ClassificationAttemptObservation): void;
  recordDeletion(observation: DeletionObservation): void;
  stop(): Promise<StatsHealth>;
  health(): StatsHealth;
}

export type StatsHealth = {
  pendingChats: number;
  pendingClassificationAttempts: number;
  pendingDeletions: number;
  droppedChats: number;
  droppedClassificationAttempts: number;
  droppedDeletions: number;
  flushFailures: number;
};

type BufferOptions = {
  flushIntervalMs?: number;
  batchSize?: number;
  maxPendingChats?: number;
  maxPendingClassificationAttempts?: number;
  maxPendingDeletions?: number;
  dbTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  shutdownTimeoutMs?: number;
  random?: () => number;
  logger?: Pick<Console, "info" | "error">;
  autoStart?: boolean;
};

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/duck", import.meta.url));

type ChatUpsert = {
  chatId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  chatType: string | null;
  membershipActive: boolean | null;
  deletions: number;
  cache: number;
  attempts: number;
};

export class DuckDbStatsStore implements StatsStore {
  private migration?: Promise<void>;

  async writeBatch(batch: StatsBatch): Promise<void> {
    await this.ensureMigrated();
    const chats = new Map<string, ChatUpsert>();
    const ensureChat = (
      chatId: string,
      seenAt: string,
      chatType: string | null,
      membershipActive: boolean | null,
    ): ChatUpsert => {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = { chatId, firstSeenAt: seenAt, lastSeenAt: seenAt, chatType, membershipActive, deletions: 0, cache: 0, attempts: 0 };
        chats.set(chatId, chat);
        return chat;
      }
      if (seenAt < chat.firstSeenAt) chat.firstSeenAt = seenAt;
      if (seenAt > chat.lastSeenAt) chat.lastSeenAt = seenAt;
      if (chatType !== null) chat.chatType = chatType;
      if (membershipActive !== null) chat.membershipActive = membershipActive;
      return chat;
    };

    for (const chat of batch.chats) {
      ensureChat(chat.chatId, chat.firstSeenAt, chat.chatType, chat.membershipActive);
      if (chat.lastSeenAt > chat.firstSeenAt) ensureChat(chat.chatId, chat.lastSeenAt, null, null);
    }

    for (const deletion of batch.deletions) {
      const chat = ensureChat(deletion.chatId, deletion.deletedAt, null, null);
      const inserted = await duckQuery(
        `INSERT INTO deletion_dedup (chat_id, message_id, deleted_at, source)
         VALUES ($1::BIGINT, $2::BIGINT, $3::TIMESTAMPTZ, COALESCE($4::TEXT, 'jev'))
         ON CONFLICT (chat_id, message_id) DO NOTHING
         RETURNING source`,
        [deletion.chatId, deletion.messageId, deletion.deletedAt, deletion.source ?? null],
      );
      if (inserted.rows.length > 0 && inserted.rows[0]) {
        chat.deletions += 1;
        if (inserted.rows[0].source === "cache") chat.cache += 1;
      }
    }

    for (const attempt of batch.classificationAttempts) {
      const chat = ensureChat(attempt.chatId, attempt.attemptedAt, null, null);
      const inserted = await duckQuery(
        `INSERT INTO classification_attempt_dedup (update_id, chat_id, message_id, attempted_at)
         VALUES ($1::BIGINT, $2::BIGINT, $3::BIGINT, $4::TIMESTAMPTZ)
         ON CONFLICT (update_id) DO NOTHING
         RETURNING chat_id`,
        [attempt.updateId, attempt.chatId, attempt.messageId, attempt.attemptedAt],
      );
      if (inserted.rows.length > 0) chat.attempts += 1;
    }

    if (chats.size > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      let index = 0;
      for (const chat of chats.values()) {
        const p = (offset: number) => `$${index + offset}`;
        values.push(`(${p(1)}::BIGINT, ${p(2)}::TIMESTAMPTZ, ${p(3)}::TIMESTAMPTZ, ${p(4)}::TEXT, ${p(5)}::BOOLEAN, ${p(6)}::BIGINT, ${p(7)}::BIGINT, ${p(8)}::BIGINT)`);
        params.push(chat.chatId, chat.firstSeenAt, chat.lastSeenAt, chat.chatType, chat.membershipActive, chat.deletions, chat.cache, chat.attempts);
        index += 8;
      }
      await duckQuery(
        `INSERT INTO known_chats (chat_id, first_seen_at, last_seen_at, chat_type, membership_active, successful_deletions, cache_deletions, processed_messages)
         VALUES ${values.join(", ")}
         ON CONFLICT (chat_id) DO UPDATE SET
           first_seen_at = LEAST(known_chats.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(known_chats.last_seen_at, EXCLUDED.last_seen_at),
           chat_type = COALESCE(EXCLUDED.chat_type, known_chats.chat_type),
           membership_active = COALESCE(EXCLUDED.membership_active, known_chats.membership_active),
           successful_deletions = known_chats.successful_deletions + EXCLUDED.successful_deletions,
           cache_deletions = known_chats.cache_deletions + EXCLUDED.cache_deletions,
           processed_messages = known_chats.processed_messages + EXCLUDED.processed_messages,
           updated_at = NOW()`,
        params,
      );
    }

    await duckQuery(
      "DELETE FROM deletion_dedup WHERE deleted_at < NOW() - ($1::INTEGER * INTERVAL 1 DAY)",
      [DEDUPE_RETENTION_DAYS],
    );
    await duckQuery(
      "DELETE FROM classification_attempt_dedup WHERE attempted_at < NOW() - ($1::INTEGER * INTERVAL 1 DAY)",
      [DEDUPE_RETENTION_DAYS],
    );
  }

  async close(): Promise<void> {
    // The DuckDB connection is shared process-wide and closed by lifecycle.ts.
  }

  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = duckMigrate(MIGRATIONS_DIR).catch((error) => {
        this.migration = undefined;
        throw error;
      });
    }
    return this.migration;
  }
}

export class AsyncStatsBuffer implements StatsRecorder {
  private readonly chats = new Map<string, PendingChat>();
  private readonly classificationAttempts = new Map<string, PendingClassificationAttempt>();
  private readonly deletions = new Map<string, PendingDeletion>();
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxPendingChats: number;
  private readonly maxPendingClassificationAttempts: number;
  private readonly maxPendingDeletions: number;
  private readonly dbTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly random: () => number;
  private readonly logger: Pick<Console, "info" | "error">;
  private timer?: ReturnType<typeof setTimeout>;
  private writeInFlight?: Promise<void>;
  private stopPromise?: Promise<StatsHealth>;
  private lifecycle: "running" | "draining" | "stopped" = "running";
  private retryNotBefore = 0;
  private failures = 0;
  private droppedChats = 0;
  private droppedClassificationAttempts = 0;
  private droppedDeletions = 0;
  private lastFailureLogAt = 0;
  private lastOverflowLogAt = 0;
  private storageReady = false;

  constructor(private readonly store: StatsStore, options: BufferOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    this.maxPendingChats = options.maxPendingChats ?? 1_000;
    this.maxPendingClassificationAttempts = options.maxPendingClassificationAttempts ?? 10_000;
    this.maxPendingDeletions = options.maxPendingDeletions ?? 1_000;
    this.dbTimeoutMs = options.dbTimeoutMs ?? 2_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? console;
    if (options.autoStart !== false) this.schedule(this.flushIntervalMs);
  }

  observeChat({ chatId, seenAt = new Date(), chatType, membershipActive }: ChatObservation): void {
    if (this.lifecycle !== "running") return;
    const key = normalizeId(chatId);
    const previous = this.chats.get(key);
    if (!previous && this.chats.size >= this.maxPendingChats) {
      this.droppedChats += 1;
      this.logOverflow();
      return;
    }
    const timestamp = seenAt.toISOString();
    this.chats.set(key, {
      chatId: key,
      firstSeenAt: previous && previous.firstSeenAt < timestamp ? previous.firstSeenAt : timestamp,
      lastSeenAt: previous && previous.lastSeenAt > timestamp ? previous.lastSeenAt : timestamp,
      chatType: chatType ?? previous?.chatType ?? null,
      membershipActive: membershipActive ?? previous?.membershipActive ?? null,
    });
    this.schedule(this.flushIntervalMs);
  }

  recordClassificationAttempt({
    chatId,
    messageId,
    updateId,
    attemptedAt = new Date(),
  }: ClassificationAttemptObservation): void {
    if (this.lifecycle !== "running") return;
    const normalizedUpdateId = normalizeId(updateId);
    if (this.classificationAttempts.has(normalizedUpdateId)) return;
    if (this.classificationAttempts.size >= this.maxPendingClassificationAttempts) {
      this.droppedClassificationAttempts += 1;
      this.logOverflow();
      return;
    }
    this.classificationAttempts.set(normalizedUpdateId, {
      chatId: normalizeId(chatId),
      messageId: normalizeId(messageId),
      updateId: normalizedUpdateId,
      attemptedAt: attemptedAt.toISOString(),
    });
    this.schedule(this.flushIntervalMs);
  }

  recordDeletion({ chatId, messageId, deletedAt = new Date(), source }: DeletionObservation): void {
    if (this.lifecycle !== "running") return;
    const normalizedChatId = normalizeId(chatId);
    const normalizedMessageId = normalizeId(messageId);
    const key = `${normalizedChatId}:${normalizedMessageId}`;
    if (this.deletions.has(key)) return;
    if (this.deletions.size >= this.maxPendingDeletions) {
      this.droppedDeletions += 1;
      this.logOverflow();
      return;
    }
    this.deletions.set(key, {
      chatId: normalizedChatId,
      messageId: normalizedMessageId,
      deletedAt: deletedAt.toISOString(),
      ...(source ? { source } : {}),
    });
    this.schedule(this.flushIntervalMs);
  }

  health(): StatsHealth {
    return {
      pendingChats: this.chats.size,
      pendingClassificationAttempts: this.classificationAttempts.size,
      pendingDeletions: this.deletions.size,
      droppedChats: this.droppedChats,
      droppedClassificationAttempts: this.droppedClassificationAttempts,
      droppedDeletions: this.droppedDeletions,
      flushFailures: this.failures,
    };
  }

  async flush(): Promise<void> {
    if (
      this.lifecycle === "stopped" ||
      this.writeInFlight ||
      (!this.chats.size && !this.classificationAttempts.size && !this.deletions.size)
    ) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.retryNotBefore = 0;

    const chats = [...this.chats.values()].slice(0, this.batchSize);
    const classificationAttempts = [...this.classificationAttempts.values()].slice(0, this.batchSize);
    const deletions = [...this.deletions.values()].slice(0, this.batchSize);
    const batch = { chats, classificationAttempts, deletions };
    const startedFailures = this.failures;
    const operation = Promise.resolve().then(() => this.store.writeBatch(batch)).then(
      () => {
        for (const chat of chats) {
          if (this.chats.get(chat.chatId) === chat) this.chats.delete(chat.chatId);
        }
        for (const deletion of deletions) {
          const key = `${deletion.chatId}:${deletion.messageId}`;
          if (this.deletions.get(key) === deletion) this.deletions.delete(key);
        }
        for (const attempt of classificationAttempts) {
          if (this.classificationAttempts.get(attempt.updateId) === attempt) {
            this.classificationAttempts.delete(attempt.updateId);
          }
        }
        this.failures = 0;
        this.retryNotBefore = 0;
        if (!this.storageReady) {
          this.storageReady = true;
          this.logger.info(JSON.stringify({ event: "stats_storage_ready", ...this.health() }));
        }
        if (startedFailures) {
          this.logger.info(JSON.stringify({ event: "stats_flush_recovered", ...this.health() }));
        }
      },
      (error) => {
        this.failures += 1;
        this.retryNotBefore = Date.now() + this.retryDelay();
        this.logFailure("write_failed", error);
      },
    ).finally(() => {
      this.writeInFlight = undefined;
      if (this.lifecycle === "running") {
        const waitMs = this.failures ? Math.max(0, this.retryNotBefore - Date.now()) : this.flushIntervalMs;
        this.schedule(waitMs);
      }
    });
    this.writeInFlight = operation;

    const completed = await Promise.race([
      operation.then(() => true),
      delay(this.dbTimeoutMs).then(() => false),
    ]);
    if (!completed) this.logFailure("deadline_exceeded");
  }

  async stop(): Promise<StatsHealth> {
    this.stopPromise ??= this.drainAndClose();
    return this.stopPromise;
  }

  private async drainAndClose(): Promise<StatsHealth> {
    this.lifecycle = "draining";
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = Date.now() + this.shutdownTimeoutMs;

    while (
      (this.chats.size || this.classificationAttempts.size || this.deletions.size || this.writeInFlight) &&
      Date.now() < deadline
    ) {
      if (this.writeInFlight) {
        await Promise.race([this.writeInFlight, delay(Math.max(1, deadline - Date.now()))]);
      } else {
        const retryWaitMs = Math.min(
          Math.max(0, this.retryNotBefore - Date.now()),
          Math.max(0, deadline - Date.now()),
        );
        if (retryWaitMs > 0) {
          await delay(retryWaitMs);
          continue;
        }
        await Promise.race([
          this.flush(),
          delay(Math.max(1, deadline - Date.now())),
        ]);
      }
    }

    this.lifecycle = "stopped";
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.race([
      Promise.resolve()
        .then(() => this.store.close())
        .catch((error) => this.logFailure("close_failed", error)),
      delay(Math.max(0, deadline - Date.now())),
    ]);
    return this.health();
  }

  private schedule(delayMs: number): void {
    if (this.lifecycle !== "running" || this.timer || this.writeInFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.lifecycle === "running") void this.flush();
    }, delayMs);
    this.timer.unref();
  }

  private retryDelay(): number {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures - 1, 10));
    return Math.round(exponential * (0.75 + this.random() * 0.5));
  }

  private logFailure(reason: string, error?: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < 60_000) return;
    this.lastFailureLogAt = now;
    this.logger.error(JSON.stringify({
      event: "stats_flush_failed",
      reason,
      kind: error instanceof Error ? error.name : error ? "unknown" : undefined,
      ...this.health(),
    }));
  }

  private logOverflow(): void {
    const now = Date.now();
    if (now - this.lastOverflowLogAt < 60_000) return;
    this.lastOverflowLogAt = now;
    this.logger.error(JSON.stringify({ event: "stats_queue_overflow", ...this.health() }));
  }
}

export function createStatsRecorder(): StatsRecorder {
  return new AsyncStatsBuffer(new DuckDbStatsStore());
}

function normalizeId(id: number | bigint | string): string {
  return BigInt(id).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
