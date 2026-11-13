// Run only with release authorization using the product bot's protected environment.
// No text, recipient, source-message, or content-export arguments are accepted.
import { Api, GrammyError } from "grammy";
import { AUDIT_CHAT_ID, DuckDbDeletionAudit } from "../src/audit-outbox";

// Which protected step failed. Content-free: no report text, no chat identity and
// no Telegram error description (it can embed the sink title or username).
let step = "init";

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["check", "send-integration"].includes(mode!)) throw new Error("Usage: bun scripts/audit-report.ts check|send-integration");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Protected bot token environment required");
  const api = new Api(token, { timeoutSeconds: 10 });
  step = "getMe";
  const me = await api.getMe();
  step = "getChatMember";
  const member = await api.getChatMember(AUDIT_CHAT_ID, me.id);
  step = "getChat";
  const chat = await api.getChat(AUDIT_CHAT_ID);
  const access = member.status === "creator" || member.status === "administrator" ||
    (member.status === "member" && (chat.type === "group" || chat.type === "supergroup") && chat.permissions?.can_send_messages === true) ||
    (member.status === "restricted" && member.is_member && member.can_send_messages);
  step = "membership";
  console.info(JSON.stringify({ event: "audit_membership", canSend: Boolean(access), memberStatus: member.status, chatType: chat.type }));
  if (!access) throw new Error("Audit sink membership or send permission required");
  if (mode === "check") return;
  const audit = new DuckDbDeletionAudit(api, { logger: (line) => console.info(line) });
  try {
    step = "outbox_init";
    await audit.initialize();
    step = "prepare";
    const id = await audit.integrationReport();
    if (!id) throw new Error("Integration probe already retained or outbox unavailable; inspect audit counters, do not blindly repeat");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      step = "poll";
      await audit.runOnce();
      const state = await audit.status(id);
      if (state === "sent") { console.info(JSON.stringify({ event: "audit_integration", receipt: "telegram_accepted", sinkMessageIds: (await audit.receipts(id)).map(part => part.messageId), deletion: false })); return; }
      if (["send_unknown", "terminal", "delete_unknown"].includes(state ?? "")) throw new Error("Integration report did not reach a confirmed receipt; inspect private sink, do not blindly resend");
      await Bun.sleep(1_000);
    }
    throw new Error("Integration report remains queued; worker owns continuation, no receipt claimed");
  } catch (error) {
    // Capture the failing step before close() overwrites it; the outer catch reports it.
    if (error && typeof error === "object") (error as { step?: string }).step = step;
    throw error;
  } finally { await audit.close(); }
}
try { await main(); }
catch (error) {
  console.error(JSON.stringify({
    event: "audit_integration_failed",
    step: (error as { step?: string } | null)?.step ?? step,
    ...(error instanceof GrammyError ? { errorCode: error.error_code } : {}),
    errorName: error instanceof Error ? error.name : "unknown",
    action: "Check protected configuration, membership and outbox status; no receipt claimed",
  }));
  process.exitCode = 1;
}
