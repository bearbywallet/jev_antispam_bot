// Deletion audit outbox: durable at-most-once report delivery to the audit chat.
// DuckDB port: embedded single-writer file replaces the Postgres cluster, so
// pg transactions/advisory locks/SKIP LOCKED collapse into plain sequential
// statements on one shared connection (see migrations/duck/00{4,5}*.sql).

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GrammyError, type Api } from "grammy";
import { duckMigrate, duckQuery } from "./duck";

export const AUDIT_CHAT_ID = -5477973916;
export interface DeletionAudit {
  prepare(chatId: number, messageId: number, report: string | string[]): Promise<string | undefined>;
  confirmed(id: string): Promise<void>;
  failed(id: string, ambiguous?: boolean): Promise<void>;
}
type AuditApi = Pick<Api, "sendMessage">;
type Options = { capacity?: number; retentionMs?: number; timeoutMs?: number; intentLeaseMs?: number;
  sendLeaseMs?: number; pollMs?: number; paceMs?: number;
  /** Content-free failure telemetry: state and Telegram error code only. */
  logger?: (line: string) => void };
type Claimed = { id: string; sequence: number; report: string; lease_token: string; attempts: number; lease_until: Date };
export const MAX_AUDIT_PARTS = 256;
const DAY = 86_400_000;
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/duck", import.meta.url));
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid audit limit");
  return result;
}

/** One attempt only. No transformer retries: a lost response is not proof of non-delivery. */
export async function sendAuditReport(api: AuditApi, report: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([
      api.sendMessage(AUDIT_CHAT_ID, report, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }, controller.signal as Parameters<Api["sendMessage"]>[3]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Audit transport timeout")); }, timeoutMs);
      }),
    ]);
    if (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id <= 0) throw new Error("Invalid audit receipt");
    return receipt.message_id;
  } finally { if (timer) clearTimeout(timer); }
}

export class DuckDbDeletionAudit implements DeletionAudit {
  private readonly api: AuditApi;
  private readonly limits: Required<Omit<Options, "logger">>;
  private migration?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly counters = { prepared: 0, refused: 0, duplicate: 0, confirmed: 0, deleteFailed: 0,
    deleteUnknown: 0, sent: 0, sendUnknown: 0, retried: 0, terminal: 0, expired: 0, expiredUndelivered: 0, error: 0 };
  private readonly log: (line: string) => void;
  constructor(api: AuditApi, options: Options = {}) {
    const timeoutMs = bounded(options.timeoutMs, 10_000, 10, 30_000);
    const sendLeaseMs = bounded(options.sendLeaseMs, 60_000, timeoutMs + 100, 120_000);
    this.limits = { timeoutMs, sendLeaseMs,
      capacity: bounded(options.capacity, 10_000, 1, 100_000),
      retentionMs: bounded(options.retentionMs, 7 * DAY, sendLeaseMs + 100, 30 * DAY),
      intentLeaseMs: bounded(options.intentLeaseMs, 120_000, 100, 300_000),
      pollMs: bounded(options.pollMs, 10, 1, 60_000),
      paceMs: bounded(options.paceMs, 3_100, 1, 60_000),
    };
    this.api = api;
    this.log = options.logger ?? (() => {});
  }
  health() { return { ...this.counters }; }
  initialize(): Promise<void> {
    return this.migration ??= duckMigrate(MIGRATIONS_DIR).catch(() => {
      this.migration = undefined; this.counters.error++;
      throw new Error("Audit database initialization failed");
    });
  }
  /** Single-writer replacement for the per-transaction sink lock: the sink row
   *  must exist (created by migration); capacity/pacing live in that row. */
  private async ensureSink() {
    const sink = await duckQuery("SELECT 1 AS ok FROM deletion_audit_sink WHERE chat_id=$1", [AUDIT_CHAT_ID]);
    if (sink.rowCount !== 1) throw new Error("Audit sink unavailable");
  }
  private async maintain() {
    const staleParts = await duckQuery(
      "UPDATE deletion_audit_parts SET state='send_unknown',lease_until=NULL,lease_token=NULL WHERE state='sending' AND lease_until<=now() AND audit_id IN (SELECT id FROM deletion_audit_outbox WHERE state='sending' AND lease_until<=now()) RETURNING 1");
    this.counters.sendUnknown += staleParts.rowCount;
    const stale = await duckQuery(
      "UPDATE deletion_audit_outbox SET state=CASE state WHEN 'intent' THEN 'delete_unknown' ELSE 'send_unknown' END, lease_until=NULL, lease_token=NULL WHERE state IN ('intent','sending') AND lease_until<=now() RETURNING state");
    for (const row of stale.rows) this.counters[row.state === "delete_unknown" ? "deleteUnknown" : "sendUnknown"]++;
    // Expired completed intents are deleted; unknown outcomes are accounted once.
    const gone = await duckQuery("DELETE FROM deletion_audit_outbox WHERE expires_at<=now() AND state NOT IN ('intent','sending') RETURNING state");
    if (gone.rowCount > 0) {
      await duckQuery("DELETE FROM deletion_audit_parts WHERE audit_id NOT IN (SELECT id FROM deletion_audit_outbox)");
      const undelivered = gone.rows.filter((row) => ["pending", "send_unknown", "delete_unknown", "terminal"].includes(String(row.state))).length;
      this.counters.expired += gone.rowCount;
      this.counters.expiredUndelivered += undelivered;
      await duckQuery("UPDATE deletion_audit_sink SET expired=expired+$1, expired_undelivered=expired_undelivered+$2", [gone.rowCount, undelivered]);
    }
  }
  private tail: Promise<unknown> = Promise.resolve();

  async prepare(chatId: number, messageId: number, report: string | string[]): Promise<string | undefined> {
    if (this.closing) { this.counters.error++; return; }
    const parts = (Array.isArray(report) ? report : [report]).slice(0, MAX_AUDIT_PARTS);
    if (chatId === AUDIT_CHAT_ID || messageId <= 0
      || parts.length < 1 || parts.some((part) => part.length < 1 || part.length > 4000 || Buffer.byteLength(part, "utf8") > 16000)) {
      this.counters.refused++; return;
    }
    // DuckDB is single-writer: serialize the read-decide-write sequence so
    // concurrent prepare() callers observe each other atomically.
    const run = this.tail.then(() => this.prepareLocked(chatId, messageId, parts));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async prepareLocked(chatId: number, messageId: number, parts: string[]): Promise<string | undefined> {
    try {
      await this.initialize();
      await this.ensureSink();
      await this.maintain();
      const existing = (await duckQuery("SELECT id,state FROM deletion_audit_outbox WHERE chat_id=$1 AND message_id=$2", [chatId, messageId])).rows[0];
      if (existing && existing.state !== "delete_failed") { this.counters.duplicate++; return; }
      const occupied = Number((await duckQuery("SELECT COUNT(*)::int AS count FROM deletion_audit_parts WHERE audit_id IS DISTINCT FROM $1::uuid", [existing?.id ?? null])).rows[0]?.count ?? 0);
      if (occupied + parts.length > this.limits.capacity) {
        await duckQuery("UPDATE deletion_audit_sink SET refused=refused+1"); this.counters.refused++; return;
      }
      const id = randomUUID();
      // Replace only known-failed intent, fencing its old callbacks.
      if (existing) await duckQuery("DELETE FROM deletion_audit_outbox WHERE id=$1", [existing.id]);
      await duckQuery(
        "INSERT INTO deletion_audit_outbox(id,chat_id,message_id,report,state,expires_at,lease_until) VALUES ($1::uuid,$2,$3,$4,'intent',now()+$5::BIGINT*INTERVAL 1 MILLISECOND,now()+$6::BIGINT*INTERVAL 1 MILLISECOND)",
        [id, chatId, messageId, parts[0], this.limits.retentionMs, this.limits.intentLeaseMs]);
      await duckQuery(
        "INSERT INTO deletion_audit_parts(audit_id,sequence,report,state) SELECT $1::uuid, i, l[i], 'pending' FROM generate_series(1, len(CAST($2::JSON AS VARCHAR[]))) AS g(i), (SELECT CAST($2::JSON AS VARCHAR[]) AS l)",
        [id, JSON.stringify(parts)]);
      await duckQuery("UPDATE deletion_audit_sink SET prepared=prepared+1"); this.counters.prepared++;
      return id;
    } catch { this.counters.error++; this.counters.refused++; return; }
  }
  async status(id: string): Promise<string | undefined> {
    try {
      await this.initialize();
      return (await duckQuery("SELECT state FROM deletion_audit_outbox WHERE id=$1::uuid", [id])).rows[0]?.state as string | undefined;
    } catch { this.counters.error++; throw new Error("Audit status unavailable"); }
  }
  /** Confirmed sink IDs only, in part order; no report or source identity. */
  async receipts(id: string): Promise<Array<{ sequence: number; messageId: number }>> {
    try {
      await this.initialize();
      const rows = await duckQuery("SELECT sequence,receipt_message_id FROM deletion_audit_parts WHERE audit_id=$1::uuid AND state='sent' AND receipt_message_id IS NOT NULL ORDER BY sequence", [id]);
      return rows.rows.map((row) => ({ sequence: Number(row.sequence), messageId: Number(row.receipt_message_id) }));
    } catch { this.counters.error++; throw new Error("Audit receipts unavailable"); }
  }
  /** Fixed two-part self-check through the exact outbox/transport path; synthetic
   *  source (chat 0, message 1) dedupes until the probe expires. Never a deletion. */
  async integrationReport(): Promise<string | undefined> {
    const id = await this.prepare(0, 1, [
      "Integration report — NOT a deletion (1/2): audit outbox self-check.",
      "Integration report — NOT a deletion (2/2): transport and durability verified.",
    ]);
    if (id) await this.confirmed(id);
    return id;
  }
  async confirmed(id: string): Promise<void> { await this.finishDeletion(id, "pending"); }
  async failed(id: string, ambiguous = false): Promise<void> { await this.finishDeletion(id, ambiguous ? "delete_unknown" : "delete_failed"); }
  private async finishDeletion(id: string, state: string) {
    if (this.closing) { this.counters.error++; return; }
    try {
      await this.initialize();
      const result = await duckQuery(
        "UPDATE deletion_audit_outbox SET state=$2,lease_until=NULL WHERE id=$1::uuid AND state='intent' AND lease_until>now() AND expires_at>now()",
        [id, state]);
      if (result.rowCount) this.counters[state === "pending" ? "confirmed" : state === "delete_unknown" ? "deleteUnknown" : "deleteFailed"]++;
    } catch { this.counters.error++; } // Durable intent remains unknown; never misreport a classification failure.
  }
  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => { this.work ??= this.tick().finally(() => { this.work = undefined; }); }, this.limits.pollMs);
    this.timer.unref?.();
  }
  /** One worker step; exposed for tests and manual draining. */
  runOnce(): Promise<void> { return this.tick(); }
  private async tick() {
    await this.initialize();
    const row = await this.claim();
    if (!row) return;
    let state = "sent", delay = this.limits.paceMs;
    let receipt: number | null = null;
    let errorCode: number | null = null;
    try { receipt = await sendAuditReport(this.api, row.report, this.limits.timeoutMs); }
    catch (error) {
      errorCode = error instanceof GrammyError ? error.error_code : null;
            // Only an explicit Telegram rejection proves the request was not accepted.
      if (error instanceof GrammyError && error.error_code === 429) {
        const seconds = error.parameters.retry_after;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 30 * 86400) {
          delay = Math.max(delay, seconds * 1000 + 1000);
          state = row.attempts < 5 ? "pending" : "terminal";
        } else state = "terminal";
      } else if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500) state = "terminal";
      else state = "send_unknown"; // Network/timeouts/5xx can follow delivery: never blindly resend.
    }
    try {
      await this.initialize();
      await this.ensureSink();
      const updated = await duckQuery(
        "UPDATE deletion_audit_parts SET state=$4,lease_until=NULL,lease_token=NULL,next_attempt_at=now()+$5::BIGINT*INTERVAL 1 MILLISECOND,receipt_message_id=$6 WHERE audit_id=$1::uuid AND sequence=$2 AND state='sending' AND lease_token=$3::uuid AND lease_until>now()",
        [row.id, row.sequence, row.lease_token, state, delay, receipt]);
      if (updated.rowCount) {
        const remaining = state === "sent" && (await duckQuery("SELECT 1 AS ok FROM deletion_audit_parts WHERE audit_id=$1::uuid AND state<>'sent' LIMIT 1", [row.id])).rowCount;
        await duckQuery(
          "UPDATE deletion_audit_outbox SET state=$3,lease_until=NULL,lease_token=NULL,next_attempt_at=now()+$4::BIGINT*INTERVAL 1 MILLISECOND WHERE id=$1::uuid AND state='sending' AND lease_token=$2::uuid",
          [row.id, row.lease_token, remaining ? "pending" : state, delay]);
        // Completion-based pacing is conservative and survives a 429/restart/second worker.
        await duckQuery("UPDATE deletion_audit_sink SET next_send_at=GREATEST(next_send_at,now()+$1::BIGINT*INTERVAL 1 MILLISECOND)", [this.limits.paceMs]);
        this.counters[state === "sent" ? "sent" : state === "pending" ? "retried" : state === "terminal" ? "terminal" : "sendUnknown"]++;
        // Surface WHY a report never reached the sink; no report text, no chat identity.
        if (state !== "sent") this.log(JSON.stringify({ event: "audit_send_failed", state, errorCode, attempt: Number(row.attempts) }));
      }
    } catch { this.counters.error++; }
  }
  /** Single outstanding send per sink; single writer, so a plain guarded claim suffices. */
  private async claim(): Promise<Claimed | undefined> {
    await this.ensureSink();
    await this.maintain();
    if (!(await duckQuery("SELECT 1 AS ok FROM deletion_audit_sink WHERE next_send_at<=now()")).rowCount) return;
    // One outstanding send per sink, including across restarts.
    if ((await duckQuery("SELECT 1 AS ok FROM deletion_audit_outbox WHERE state='sending' LIMIT 1")).rowCount) return;
    const candidate = (await duckQuery(
      "SELECT o.id,p.sequence FROM deletion_audit_outbox o JOIN deletion_audit_parts p ON p.audit_id=o.id WHERE o.state='pending' AND o.expires_at>now() AND p.state='pending' AND p.next_attempt_at<=now() AND NOT EXISTS (SELECT 1 FROM deletion_audit_parts earlier WHERE earlier.audit_id=o.id AND earlier.sequence<p.sequence AND earlier.state<>'sent') ORDER BY p.next_attempt_at,o.created_at,p.sequence LIMIT 1")).rows[0];
    if (!candidate) return;
    const token = randomUUID();
    const claimed = (await duckQuery(
      "UPDATE deletion_audit_parts SET state='sending',lease_until=now()+$3::BIGINT*INTERVAL 1 MILLISECOND,lease_token=$4::uuid,attempts=attempts+1 WHERE audit_id=$1::uuid AND sequence=$2 AND state='pending' RETURNING audit_id AS id,sequence,report,lease_token,attempts,lease_until",
      [candidate.id, Number(candidate.sequence), this.limits.sendLeaseMs, token])).rows[0];
    if (!claimed) return;
    await duckQuery(
      "UPDATE deletion_audit_outbox SET state='sending',lease_until=$2::TIMESTAMPTZ,lease_token=$3::uuid,attempts=$4 WHERE id=$1::uuid",
      [candidate.id, claimed.lease_until instanceof Date ? claimed.lease_until.toISOString() : String(claimed.lease_until), token, Number(claimed.attempts)]);
    await duckQuery("UPDATE deletion_audit_sink SET next_send_at=now()+$1::BIGINT*INTERVAL 1 MILLISECOND", [this.limits.paceMs]);
    return claimed as Claimed;
  }
  async summary(): Promise<Record<string, number>> {
    try {
      await this.initialize();
      const rows = await duckQuery("SELECT state,COUNT(*)::int AS count FROM deletion_audit_outbox GROUP BY state");
      const sink = (await duckQuery("SELECT prepared,refused,expired,expired_undelivered FROM deletion_audit_sink")).rows[0];
      return Object.fromEntries([...rows.rows.map((row) => [row.state, Number(row.count)]), ...Object.entries(sink ?? {}).map(([key, value]) => [key, Number(value)])]);
    } catch { this.counters.error++; throw new Error("Audit summary unavailable"); }
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true; if (this.timer) clearInterval(this.timer);
      await this.work;
      // The DuckDB connection is shared process-wide; lifecycle.ts closes it.
    })();
  }
}
