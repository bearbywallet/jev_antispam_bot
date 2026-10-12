import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Api, GrammyError } from "grammy";
import { AUDIT_CHAT_ID, DuckDbDeletionAudit, sendAuditReport } from "./audit-outbox";
import { renderAuditReport, type AuditSnapshot } from "./audit-report";
import { duckExec, duckQuery } from "./duck";

process.env.DUCKDB_PATH ??= "/tmp/jev_antispam_test.duckdb";
const integration = test;
const options = { paceMs: 1, timeoutMs: 100, sendLeaseMs: 1_000, pollMs: 5 };
function accepted(messageId: number) { return { ok: true, result: { message_id: messageId } }; }
/** Make grammy throw the same error the real transport raises on a failed API response. */
function telegramError(code: number, description: string, parameters?: { retry_after: number }) {
  return new GrammyError(description, { ok: false, error_code: code, description, parameters: parameters ?? {} }, "sendMessage", { chat_id: AUDIT_CHAT_ID });
}
async function fixture() {
  const api = new Api("123:fixture");
  const calls: unknown[] = [];
  let action: () => Promise<unknown> = async () => accepted(1);
  api.config.use(async (_previous: unknown, _method: unknown, payload: unknown) => { calls.push(payload); return await action() as never; });
  const audit = new DuckDbDeletionAudit(api, options);
  await audit.initialize();
  await duckQuery("DELETE FROM deletion_audit_parts");
  await duckQuery("DELETE FROM deletion_audit_outbox");
  await duckQuery("INSERT INTO deletion_audit_sink(chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING", [AUDIT_CHAT_ID]);
  await duckQuery("UPDATE deletion_audit_sink SET next_send_at=NOW(),prepared=0,refused=0,expired=0,expired_undelivered=0");
  const state = async (id: string) => (await duckQuery("SELECT state,attempts FROM deletion_audit_outbox WHERE id=$1::uuid", [id])).rows[0]! as { state: string; attempts: number };
  const readySink = async () => { await duckQuery("UPDATE deletion_audit_sink SET next_send_at=NOW()"); };
  const ready = async () => {
    await readySink();
    await duckQuery("UPDATE deletion_audit_outbox SET next_attempt_at=NOW()");
    await duckQuery("UPDATE deletion_audit_parts SET next_attempt_at=NOW()");
  };
  return { api, calls, action: (next: () => Promise<unknown>) => { action = next; }, audit, state, ready, readySink,
    close: async () => { await audit.close(); } };
}

integration("migration concurrency, durable intent, restart, source dedupe and no send before confirmation", async () => {
  const f = await fixture();
  const other = new DuckDbDeletionAudit(f.api, options);
  try {
    await Promise.all([f.audit.initialize(), other.initialize()]);
    const ids = await Promise.all([f.audit.prepare(-69, 1, "<b>confirmed fixture</b>"), other.prepare(-69, 1, "fixture")]);
    expect(ids.filter(Boolean)).toHaveLength(1); const id = ids.find(Boolean)!;
    expect((await f.state(id)).state).toBe("intent");
    await other.runOnce(); expect(f.calls).toHaveLength(0);
    await f.audit.close(); await other.confirmed(id); await other.confirmed(id);
    await other.runOnce(); expect(f.calls).toHaveLength(1); expect((await f.state(id)).state).toBe("sent");
    expect(await other.prepare(-69, 1, "fixture")).toBeUndefined();
    await other.runOnce(); expect(f.calls).toHaveLength(1);
  } finally { await other.close(); await f.close(); }
});

integration("known deletion failure retry fences old callbacks; ambiguity and stale intents never confirm", async () => {
  const f = await fixture();
  try {
    const first = (await f.audit.prepare(-69, 1, "fixture"))!;
    await f.audit.failed(first);
    const retry = (await f.audit.prepare(-69, 1, "retry"))!; expect(retry).not.toBe(first);
    await f.audit.confirmed(first); expect((await f.state(retry)).state).toBe("intent");
    await f.audit.failed(retry, true); await f.audit.confirmed(retry);
    expect((await f.state(retry)).state).toBe("delete_unknown");
    expect(await f.audit.prepare(-69, 1, "retry")).toBeUndefined();
    const stale = (await f.audit.prepare(-69, 2, "fixture"))!;
    await duckQuery("UPDATE deletion_audit_outbox SET lease_until=NOW()-INTERVAL 1 SECOND WHERE id=$1::uuid", [stale]);
    await f.audit.confirmed(stale); await f.audit.runOnce();
    expect((await f.state(stale)).state).toBe("delete_unknown"); expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

integration("capacity is atomic across replicas; expiry bounded, explicit and does not evict early", async () => {
  const f = await fixture();
  const a = new DuckDbDeletionAudit(f.api, { ...options, capacity: 2 });
  const b = new DuckDbDeletionAudit(f.api, { ...options, capacity: 2 });
  try {
    const ids = await Promise.all([a.prepare(-69, 1, "private fixture"), b.prepare(-69, 2, "private fixture"), a.prepare(-69, 3, "private fixture")]);
    expect(ids.filter(Boolean)).toHaveLength(2);
    for (const id of ids.filter(Boolean)) await a.confirmed(id!);
    expect(await a.prepare(-69, 4, "fixture")).toBeUndefined();
    expect((await a.summary()).pending).toBe(2);
    await duckQuery("UPDATE deletion_audit_outbox SET created_at=NOW()-INTERVAL 2 DAY,expires_at=NOW()-INTERVAL 1 DAY");
    expect(await b.prepare(-69, 4, "fixture")).toBeDefined();
    const summary = await a.summary(); expect(summary.expired).toBe(2); expect(summary.expired_undelivered).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("private"); expect(JSON.stringify(a.health())).not.toContain("fixture");
    expect(f.calls).toHaveLength(0);
  } finally { await Promise.all([a.close(), b.close()]); await f.close(); }
});

integration("429 retries only the current part and durably paces it for other workers", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const id = (await f.audit.prepare(-69, 1, ["one", "two", "three"]))!; await f.audit.confirmed(id);
    f.action(async () => accepted(101)); await f.audit.runOnce(); await f.ready();
    f.action(async () => { throw telegramError(429, "Too Many Requests: retry after 60", { retry_after: 60 }); });
    await f.audit.runOnce();
    // Part two alone is durably backed off ~60s, visible to a fresh worker.
    const backed = await duckQuery("SELECT next_attempt_at > NOW() + INTERVAL 30 SECOND AS backed, attempts FROM deletion_audit_parts WHERE audit_id=$1::uuid AND sequence=2", [id]);
    expect(backed.rows[0]!.backed).toBe(true); expect(Number(backed.rows[0]!.attempts)).toBe(1);
    const second = (await other.prepare(-69, 2, "other"))!; await other.confirmed(second);
    await f.audit.close();
    f.action(async () => accepted(102));
    // Part three stays fenced behind the backed-off part two; the fresh report advances.
    await f.readySink(); await other.runOnce();
    expect(f.calls.map(call => (call as { text: string }).text)).toEqual(["one", "two", "other"]);
    const attemptRows = await duckQuery("SELECT attempts FROM deletion_audit_parts WHERE audit_id=$1::uuid ORDER BY sequence", [id]);
    expect(attemptRows.rows.map(row => Number(row.attempts))).toEqual([1, 1, 0]);
    // Time-travel past part two's backoff: exactly part two retries, nothing else moves.
    await duckQuery("UPDATE deletion_audit_parts SET next_attempt_at=NOW() WHERE audit_id=$1::uuid AND sequence=2", [id]);
    await f.readySink(); await other.runOnce();
    expect(f.calls.map(call => (call as { text: string }).text)).toEqual(["one", "two", "other", "two"]);
    expect(Number((await duckQuery("SELECT attempts FROM deletion_audit_parts WHERE audit_id=$1::uuid AND sequence=2", [id])).rows[0]!.attempts)).toBe(2);
    expect(await other.status(id)).toBe("pending");
  } finally { await other.close(); await f.close(); }
});

integration("429 stops at five attempts with the terminal state visible to a restart", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const id = (await f.audit.prepare(-69, 1, "fixture"))!; await f.audit.confirmed(id);
    f.action(async () => { throw telegramError(429, "Too Many Requests: retry after 2", { retry_after: 2 }); });
    for (let attempt = 1; attempt <= 5; attempt++) { await f.ready(); await f.audit.runOnce(); }
    expect((await f.state(id)).state).toBe("terminal");
    expect(f.calls).toHaveLength(5);
    expect(Number((await duckQuery("SELECT attempts FROM deletion_audit_parts WHERE audit_id=$1::uuid", [id])).rows[0]!.attempts)).toBe(5);
    await f.ready(); await other.runOnce(); expect(f.calls).toHaveLength(5);
  } finally { await other.close(); await f.close(); }
});

integration("API rejections and network anomalies end in terminal or unknown, never silent success", async () => {
  const f = await fixture();
  try {
    const cases = [
      [1, async () => { throw telegramError(500, "internal"); }, "send_unknown"],
      [2, async () => { throw new Error("network down"); }, "send_unknown"],
      [3, async () => { throw telegramError(429, "Too Many Requests: retry after 60", { retry_after: 60 }); }, "pending"],
      [4, async () => { throw telegramError(403, "forbidden"); }, "terminal"],
      [5, async () => await new Promise<never>(() => {}), "send_unknown"],
    ] as const;
    const arm = async (i: number) => {
      await f.readySink();
      await duckQuery("UPDATE deletion_audit_outbox SET next_attempt_at=NOW() WHERE chat_id=-69 AND message_id=$1", [i]);
      await duckQuery("UPDATE deletion_audit_parts SET next_attempt_at=NOW() WHERE audit_id IN (SELECT id FROM deletion_audit_outbox WHERE chat_id=-69 AND message_id=$1)", [i]);
    };
    for (const [i, action] of cases) {
      f.action(action);
      const id = (await f.audit.prepare(-69, i, "fixture"))!; await f.audit.confirmed(id);
      await arm(i); await f.audit.runOnce();
    }
    for (const [i, , state] of cases) {
      const row = (await duckQuery("SELECT state FROM deletion_audit_outbox WHERE chat_id=-69 AND message_id=$1", [i])).rows[0];
      expect(row?.state).toBe(state);
    }
    expect(JSON.stringify(f.audit.health())).not.toContain("private");
  } finally { await f.close(); }
});

integration("single outstanding lease; a second worker never double-sends", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const id = (await f.audit.prepare(-69, 1, "fixture"))!; await f.audit.confirmed(id);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    f.action(async () => { await gate; return accepted(70); });
    const first = f.audit.runOnce();
    await Bun.sleep(5);
    await other.runOnce(); expect(f.calls).toHaveLength(1);
    release(); await first;
    expect(await f.audit.status(id)).toBe("sent"); expect(f.calls).toHaveLength(1);
    await f.ready(); await other.runOnce(); expect(f.calls).toHaveLength(1);
  } finally { await other.close(); await f.close(); }
});

integration("shutdown waits for active send and does not schedule another", async () => {
  const f = await fixture();
  try {
    const id = (await f.audit.prepare(-69, 1, "fixture"))!; await f.audit.confirmed(id);
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    f.action(async () => { entered(); await gate; return accepted(80); });
    f.audit.start(); f.audit.start(); await started;
    let closed = false; const closing = f.audit.close().then(() => { closed = true; });
    await Bun.sleep(10); expect(closed).toBe(false); release(); await closing;
    expect((await f.state(id)).state).toBe("sent"); expect(f.calls).toHaveLength(1);
    expect(await f.audit.prepare(-69, 2, "fixture")).toBeUndefined();
  } finally { await f.close(); }
});

integration("complete multipart snapshot survives restart with ordered no-replay delivery", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const parts = Array.from({ length: 4 }, (_, i) => "<pre>" + ("段😀 &amp; " + i).repeat(200) + "</pre>");
    const expected = [...parts]; const preparing = f.audit.prepare(-69, 1, parts); parts[0] = "caller mutation";
    const id = (await preparing)!; expect(id).toBeDefined();
    const stored = (await duckQuery("SELECT report FROM deletion_audit_parts WHERE audit_id=$1::uuid ORDER BY sequence", [id])).rows.map(row => row.report);
    expect(stored).toEqual(expected); expect(stored.join("")).toBe(expected.join(""));
    await f.audit.runOnce(); expect(f.calls).toHaveLength(0);
    await f.audit.confirmed(id);
    f.action(async () => accepted(901)); await f.ready(); await f.audit.runOnce();
    expect(await f.audit.status(id)).toBe("pending"); expect(await f.audit.receipts(id)).toEqual([{ sequence: 1, messageId: 901 }]);
    await f.audit.close();
    for (let i = 1; i < expected.length; i++) { await f.ready(); f.action(async () => accepted(901 + i)); await other.runOnce(); }
    expect(await other.status(id)).toBe("sent");
    expect(f.calls.map(call => (call as { text: string }).text)).toEqual(expected);
    expect(await other.receipts(id)).toEqual(expected.map((_, i) => ({ sequence: i + 1, messageId: 901 + i })));
  } finally { await other.close(); await f.close(); }
});

integration("ambiguous part two halts the remainder; receipts stay complete", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const id = (await f.audit.prepare(-69, 1, ["one", "two", "three"]))!; await f.audit.confirmed(id);
    let gate!: (value: unknown) => void; const hang = new Promise<never>((_, reject) => { gate = reject; });
    f.action(async () => accepted(100)); await f.audit.runOnce(); await f.ready();
    f.action(async () => { gate(new Error("ambiguous")); return hang; });
    await f.audit.runOnce();
    expect(await f.audit.status(id)).toBe("send_unknown");
    expect(await f.audit.receipts(id)).toEqual([{ sequence: 1, messageId: 100 }]);
    await other.runOnce(); expect(f.calls.map(call => (call as { text: string }).text)).toEqual(["one", "two"]);
  } finally { await other.close(); await f.close(); }
});

integration("database outage refuses deletion intent without leaking errors", async () => {
  const audit = new DuckDbDeletionAudit(new Api("123:fixture"), options);
  try {
    await audit.initialize();
    await duckQuery("DELETE FROM deletion_audit_sink");
    expect(await audit.prepare(-69, 1, "private fixture")).toBeUndefined();
    expect(audit.health().refused).toBe(1); expect(audit.health().error).toBeGreaterThan(0);
    await audit.confirmed(randomUUID()); await audit.failed(randomUUID());
    await duckQuery("INSERT INTO deletion_audit_sink(chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING", [AUDIT_CHAT_ID]);
  } finally { await audit.close(); }
});

integration("first migration is race-safe and database constraints reject invalid leases", async () => {
  await duckExec("DROP TABLE IF EXISTS deletion_audit_parts; DROP TABLE IF EXISTS deletion_audit_outbox; DROP TABLE IF EXISTS deletion_audit_sink");
  await duckQuery("DELETE FROM schema_migrations WHERE filename LIKE '00%'");
  const a = new DuckDbDeletionAudit(new Api("123:fixture"), options); const b = new DuckDbDeletionAudit(new Api("123:fixture"), options);
  try {
    await Promise.all([a.initialize(), b.initialize()]);
    const id = (await a.prepare(-69, 1, "fixture"))!; await a.confirmed(id);
    await expect(duckQuery("UPDATE deletion_audit_outbox SET state='sending' WHERE id=$1::uuid", [id])).rejects.toBeDefined();
    await expect(duckQuery("UPDATE deletion_audit_sink SET chat_id=1")).rejects.toBeDefined();
    await expect(duckQuery("UPDATE deletion_audit_outbox SET report=repeat('x',16001) WHERE id=$1::uuid", [id])).rejects.toBeDefined();
    expect((await a.summary()).prepared).toBeGreaterThanOrEqual(1);
  } finally {
    await Promise.all([a.close(), b.close()]);
    // Leave a healthy schema behind for the remaining suites.
    const c = new DuckDbDeletionAudit(new Api("123:fixture"), options);
    await duckExec("DROP TABLE IF EXISTS deletion_audit_parts; DROP TABLE IF EXISTS deletion_audit_outbox; DROP TABLE IF EXISTS deletion_audit_sink");
    await duckQuery("DELETE FROM schema_migrations WHERE filename LIKE '00%'");
    await c.initialize(); await c.close();
  }
});

integration("concise rendering and pre-upgrade queued HTML survive restart without rewriting", async () => {
  const f = await fixture(); const other = new DuckDbDeletionAudit(f.api, options);
  try {
    const legacy = ['<b>Confirmed spam deletion — part 1/2</b>\n<pre>old body</pre>', '<b>Own available reply/context</b>\n<pre>{&quot;replySource&quot;:&quot;unavailable&quot;}</pre>'];
    const oldId = (await f.audit.prepare(-71, 1, legacy))!; await f.audit.confirmed(oldId);
    const snapshot: AuditSnapshot = { chatId: -71, messageId: 2, chatTitle: "private", actor: "user:10", actorName: "Alice", senderUrl: "tg://user?id=10", edited: false, body: "new body <&>", media: "none supplied", context: '{"replySource":{"text":"direct source"}}', links: "private links", profile: "private bio" };
    const concise = renderAuditReport(snapshot);
    const newId = (await f.audit.prepare(-71, 2, concise))!; await f.audit.confirmed(newId);
    const failedId = (await f.audit.prepare(-71, 3, renderAuditReport({ ...snapshot, body: "failed deletion" })))!; await f.audit.failed(failedId);
    await f.audit.close();
    f.action(async () => accepted(901));
    for (let i = 0; i < 5; i++) { await f.ready(); await other.runOnce(); }
    expect(f.calls.map(call => (call as { text: string }).text)).toEqual([...legacy, '<a href="tg://user?id=10">Alice</a>\n<pre>new body &lt;&amp;&gt;</pre>\n\nReply to: <pre>direct source</pre>']);
    for (const call of f.calls) expect(call).toMatchObject({ chat_id: AUDIT_CHAT_ID, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(await other.status(oldId)).toBe("sent"); expect(await other.status(newId)).toBe("sent"); expect(await other.status(failedId)).toBe("delete_failed");
    expect(await other.prepare(-71, 1, concise)).toBeUndefined();
  } finally { await other.close(); await f.close(); }
});

integration("harmless integration report dedupes and never reports a deletion", async () => {
  const f = await fixture();
  try {
    const id = await f.audit.integrationReport();
    expect(id).toBeDefined();
    for (let i = 0; i < 2; i++) { await f.ready(); f.action(async () => accepted(201 + i)); await f.audit.runOnce(); }
    expect(await f.audit.status(id!)).toBe("sent");
    const payload = f.calls[0] as { chat_id: number; text: string };
    expect(payload.chat_id).toBe(AUDIT_CHAT_ID); expect(payload.text).toContain("NOT a deletion");
    expect(await f.audit.integrationReport()).toBeUndefined();
  } finally { await f.close(); }
});

test("sendAuditReport validates receipts and honours timeouts", async () => {
  const api = new Api("123:fixture");
  const calls: unknown[] = [];
  let current: () => Promise<unknown> = async () => accepted(1);
  const action = (next: () => Promise<unknown>) => { current = next; };
  api.config.use(async (_p: unknown, _m: unknown, payload: unknown) => { calls.push(payload); return await current() as never; });
  expect(await sendAuditReport(api, "fixture", 100)).toBe(1);
  action(async () => accepted(0));
  await expect(sendAuditReport(api, "fixture", 100)).rejects.toThrow("Invalid audit receipt");
  action(async () => await new Promise<never>(() => {}));
  await expect(sendAuditReport(api, "fixture", 20)).rejects.toThrow("timeout");
  expect(calls[0]).toMatchObject({ chat_id: AUDIT_CHAT_ID, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
