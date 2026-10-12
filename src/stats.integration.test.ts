import { expect, test } from "bun:test";
import { DuckDbStatsStore, AsyncStatsBuffer, type StatsBatch, type StatsStore } from "./stats";
import { closeDuck, duckQuery } from "./duck";

process.env.DUCKDB_PATH = process.env.DUCKDB_PATH || "/tmp/jev_stats_test.duckdb";
const integrationTest = process.env.DUCKDB_PATH ? test : test.skip;

async function knownChats(chatId: string) {
  return (await duckQuery(
    "SELECT chat_id, first_seen_at, last_seen_at, chat_type, membership_active, successful_deletions, cache_deletions, processed_messages FROM known_chats WHERE chat_id = $1::BIGINT",
    [chatId],
  )).rows;
}

integrationTest("runs the idempotent migration and persists restart-safe deletion totals", async () => {
  const chatId = "-9223372036854775707";
  const messageId = "9223372036854775001";
  const firstBatch: StatsBatch = {
    chats: [{
      chatId,
      firstSeenAt: "2026-09-18T01:00:00.000Z",
      lastSeenAt: "2026-09-18T01:00:00.000Z",
      chatType: "supergroup",
      membershipActive: true,
    }],
    deletions: [{ chatId, messageId, deletedAt: "2026-09-18T01:00:01.000Z" }],
    classificationAttempts: [{
      chatId,
      messageId,
      updateId: "9223372036854775003",
      attemptedAt: "2026-09-18T01:00:00.500Z",
    }],
  };

  const firstStore = new DuckDbStatsStore();
  await firstStore.writeBatch(firstBatch);
  await firstStore.close();

  const restartedStore = new DuckDbStatsStore();
  await restartedStore.writeBatch({
    chats: [{
      chatId,
      firstSeenAt: "2026-09-18T01:00:00.000Z",
      lastSeenAt: "2026-09-18T02:00:00.000Z",
      chatType: "supergroup",
      membershipActive: false,
    }],
    deletions: firstBatch.deletions,
    classificationAttempts: firstBatch.classificationAttempts,
  });
  await restartedStore.close();

  const rows = await knownChats(chatId);
  expect(rows[0]).toMatchObject({
    chat_id: chatId,
    chat_type: "supergroup",
    membership_active: false,
    successful_deletions: 1,
    processed_messages: 1,
  });
  expect(new Date(rows[0]!.first_seen_at as string).toISOString()).toBe("2026-09-18T01:00:00.000Z");
  expect(new Date(rows[0]!.last_seen_at as string).toISOString()).toBe("2026-09-18T02:00:00.000Z");
  const aggregate = await duckQuery(
    "SELECT COALESCE(SUM(successful_deletions), 0) AS total FROM known_chats WHERE chat_id = $1::BIGINT",
    [chatId],
  );
  expect(Number(aggregate.rows[0]?.total)).toBe(1);
});

integrationTest("a commit-uncertain retry cannot double-count a deletion", async () => {
  const chatId = "-9223372036854775607";
  const messageId = "9223372036854775002";
  const delegate = new DuckDbStatsStore();
  let throwAfterCommit = true;
  const uncertainStore: StatsStore = {
    writeBatch: async (batch) => {
      await delegate.writeBatch(batch);
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error("connection lost after commit");
      }
    },
    close: () => delegate.close(),
  };
  const stats = new AsyncStatsBuffer(uncertainStore, { autoStart: false, logger: silentLogger });
  stats.recordClassificationAttempt({
    chatId,
    messageId,
    updateId: "9223372036854775004",
    attemptedAt: new Date("2026-09-18T02:59:59Z"),
  });
  stats.recordDeletion({ chatId, messageId, deletedAt: new Date("2026-09-18T03:00:00Z") });
  await stats.flush();
  await stats.flush();
  await stats.stop();

  const rows = await knownChats(chatId);
  expect(rows[0]!.successful_deletions).toBe(1);
  expect(rows[0]!.processed_messages).toBe(1);
});

integrationTest("prunes expired classification dedupe rows while preserving recent retry dedupe", async () => {
  const chatId = "-9223372036854775507";
  const oldUpdateId = "9223372036854775005";
  const recentUpdateId = "9223372036854775006";
  const recentAttempt = {
    chatId,
    messageId: "9223372036854775007",
    updateId: recentUpdateId,
    attemptedAt: new Date().toISOString(),
  };
  const store = new DuckDbStatsStore();

  await store.writeBatch({ chats: [], deletions: [], classificationAttempts: [] });
  await duckQuery("DELETE FROM classification_attempt_dedup WHERE update_id IN (SELECT unnest(CAST($1::JSON AS BIGINT[])))", [JSON.stringify([oldUpdateId, recentUpdateId])]);
  await duckQuery("DELETE FROM known_chats WHERE chat_id = $1::BIGINT", [chatId]);

  await store.writeBatch({
    chats: [],
    deletions: [],
    classificationAttempts: [{
      chatId,
      messageId: "9223372036854775006",
      updateId: oldUpdateId,
      attemptedAt: "2025-01-01T00:00:00.000Z",
    }, recentAttempt],
  });
  // The old attempt's dedupe row was written, then immediately pruned by the
  // retention sweep inside writeBatch; re-writing it counts a second message.
  await store.writeBatch({
    chats: [],
    deletions: [],
    classificationAttempts: [recentAttempt],
  });
  await store.close();

  const dedupeRows = await duckQuery(
    "SELECT update_id FROM classification_attempt_dedup WHERE update_id IN (SELECT unnest(CAST($1::JSON AS BIGINT[]))) ORDER BY update_id",
    [JSON.stringify([oldUpdateId, recentUpdateId])],
  );
  const total = await duckQuery(
    "SELECT processed_messages FROM known_chats WHERE chat_id = $1::BIGINT",
    [chatId],
  );
  expect(dedupeRows.rows).toEqual([{ update_id: recentUpdateId }]);
  expect(Number(total.rows[0]?.processed_messages)).toBe(2);
});

const silentLogger = { info: () => undefined, error: () => undefined };
