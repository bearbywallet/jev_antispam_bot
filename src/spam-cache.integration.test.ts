import { expect, test } from "bun:test";
import { DuckDbSpamCache } from "./spam-cache";
import { DuckDbStatsStore } from "./stats";
import { duckQuery } from "./duck";

process.env.DUCKDB_PATH = "/tmp/jev_cache_test.duckdb";
const integration = test;
const logger = { info: () => {} };
const key = (n: number) => n.toString(16).padStart(64, "0");

async function reset() {
  await duckQuery("DELETE FROM spam_verdict_cache");
}

integration("cache persists restart, expires, versions, prunes and bounds writes", async () => {
  const first = new DuckDbSpamCache({ logger, capacity: 3, timeoutMs: 1000 });
  await first.lookup(key(1)); await reset();
  await first.seed(key(1)); expect(await first.lookup(key(1))).toBe(true);
  const restarted = new DuckDbSpamCache({ logger, capacity: 3, timeoutMs: 1000 });
  expect(await restarted.lookup(key(1))).toBe(true);
  const before = (await duckQuery("SELECT expires_at FROM spam_verdict_cache WHERE fingerprint=$1", [key(1)])).rows[0];
  await restarted.lookup(key(1)); await restarted.seed(key(1));
  expect((await duckQuery("SELECT expires_at FROM spam_verdict_cache WHERE fingerprint=$1", [key(1)])).rows[0]).toEqual(before);
  const other = new DuckDbSpamCache({ logger, capacity: 3, timeoutMs: 1000 });
  await other.lookup(key(1));
  await Promise.all([restarted.seed(key(2)), other.seed(key(3)), restarted.seed(key(4)), other.seed(key(5))]);
  expect(Number((await duckQuery("SELECT COUNT(*)::int AS count FROM spam_verdict_cache")).rows[0]!.count)).toBe(3);
  expect(restarted.health().eviction + other.health().eviction).toBeGreaterThan(0);
  await duckQuery("UPDATE spam_verdict_cache SET expires_at=NOW()-INTERVAL 1 SECOND");
  expect(await restarted.lookup(key(5))).toBe(false);
  await restarted.seed(key(9));
  const changed = new DuckDbSpamCache({ logger, revision: "f".repeat(64), timeoutMs: 1000 });
  expect(await changed.lookup(key(9))).toBe(false);
});

integration("cache deadline never returns a positive verdict nor leaks content", async () => {
  const cache = new DuckDbSpamCache({ logger, timeoutMs: 50, ttlMs: 86_400_000, capacity: 10 });
  // A slow statement exceeds the deadline; lookup must fail closed (false).
  await reset();
  const slow = new DuckDbSpamCache({ logger, timeoutMs: 1, capacity: 10 });
  expect(await slow.lookup(key(7))).toBe(false);
  expect(await slow.seed(key(7))).toBeUndefined();
  expect(slow.health().error).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(slow.health())).not.toContain(key(7));
});

integration("stats store counts deduped deletions and cache hits restart-safely", async () => {
  const chatId = "-9223372036854775307";
  const messageId = "9223372036854775009";
  const store = new DuckDbStatsStore();
  await duckQuery("DELETE FROM known_chats WHERE chat_id = $1::BIGINT", [chatId]);
  await duckQuery("DELETE FROM deletion_dedup WHERE chat_id = $1::BIGINT", [chatId]);
  await store.writeBatch({
    chats: [{ chatId, firstSeenAt: "2026-09-18T01:00:00.000Z", lastSeenAt: "2026-09-18T01:30:00.000Z", chatType: "supergroup", membershipActive: true }],
    deletions: [{ chatId, messageId, deletedAt: "2026-09-18T01:00:01.000Z", source: "cache" }],
    classificationAttempts: [],
  });
  await store.writeBatch({
    chats: [],
    deletions: [{ chatId, messageId, deletedAt: "2026-09-18T01:00:02.000Z", source: "cache" }],
    classificationAttempts: [],
  });
  await store.close();
  const row = (await duckQuery(
    "SELECT successful_deletions, cache_deletions, processed_messages FROM known_chats WHERE chat_id=$1::BIGINT", [chatId])).rows[0];
  expect(row).toEqual({ successful_deletions: 1, cache_deletions: 1, processed_messages: 0 });
});
