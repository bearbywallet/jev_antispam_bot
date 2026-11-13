/**
 * Deterministic "DM me to get X" detection.
 *
 * The Jev classifier spreads this family across several soft questions, so a
 * terse pitch such as "去私信拿数据搞裙演" ("DM me for the data") can score under
 * SPAM_THRESHOLD and never reach the audited deletion and ban gate. This check
 * is deliberately narrow: it needs BOTH a private-contact instruction AND an
 * offered payload (data, ad content, price list, service). Moderator reports,
 * warnings and already-agreed coordination are exempt.
 */

/** Instructions that move the conversation out of the group and into PM. */
const CONTACT_PATTERNS: readonly RegExp[] = [
  // Chinese: DM / private chat / "write me privately".
  /私信/u,
  /私聊/u,
  /私我/u,
  /私戳/u,
  /私发/u,
  // English.
  /\bdm(?:s|ed)?\s+(?:me|for|us|to|it)\b/i,
  /\bdm\s+for\s+(?:the|more|full|details)\b/i,
  /\b(?:pm|p\.m\.)\s+me\b/i,
  /\b(?:write|message|text|contact|reach)\s+(?:me|us)\s+(?:in|via|on|by)?\s*(?:dm|pm|private)/i,
  /\bprivate\s+(?:message|messages|chat)\b/i,
  /\bslide\s+into\s+(?:my|the)\s+dms?\b/i,
  // Russian.
  /в\s*лс/iu,
  /в\s*личк/iu,
  /в\s*личн/iu,
  /личн(?:ые|ых|ку|ом)\s*сообщени/iu,
  /напиш(?:и|ите)\s+(?:мне\s+)?(?:в\s+)?(?:лс|личк)/iu,
];

/** The payload the sender promises once you are in PM. */
const PAYLOAD_PATTERNS: readonly RegExp[] = [
  // Chinese.
  /数据/u,
  /广告/u,
  /内容/u,
  /套餐/u,
  /引流/u,
  /推广/u,
  /群演/u,
  /资源/u,
  /资料/u,
  /价格/u,
  /报价/u,
  /服务/u,
  // English.
  /\b(?:details?|data|price|prices|pricing|rate|rates|list|lists|catalog|offer|info|information|services?|content|files?)\b/i,
  // Russian.
  /детал/iu,
  /подробност/iu,
  /данн/iu,
  /цен[аыуе]/iu,
  /прайс/iu,
  /услуг/iu,
  /контент/iu,
  /файл/iu,
];

/** Warnings, reports and coordination that must never trigger the hard rule. */
const EXEMPTION_PATTERNS: readonly RegExp[] = [
  // Chinese: "do not contact", warnings, reports.
  /不(?:要|必|用)(?:再)?联(?:系|络)/u,
  /别联(?:系|络)/u,
  /不要私(?:信|聊|戳)/u,
  /举报/u,
  /骗子/u,
  // English.
  /\bdo\s+not\s+(?:contact|dm|message|write)\b/i,
  /\bdon'?t\s+(?:contact|dm|message|write)\b/i,
  /\bnever\s+(?:contact|dm|message|write)\b/i,
  /\breport(?:ed|ing)?\b/i,
  /\bscam(?:mer)?s?\b/i,
  // Russian.
  /не\s+(?:пиши|пишите|контактируй|контактируйте)/iu,
  /как\s+(?:договаривались|ты\s+просил|просили|обсуждали)/iu,
  /жалоб/iu,
];

/** Label returned on a hit; never contains message text, safe to log. */
export const PRIVATE_CONTACT_BAIT = "private_contact_bait";

/**
 * Returns PRIVATE_CONTACT_BAIT when `text` asks readers to move to private
 * messages in order to receive a payload, otherwise null.
 */
export function privateContactBait(text?: string): string | null {
  const value = (text ?? "").trim();
  if (!value) return null;
  if (EXEMPTION_PATTERNS.some((pattern) => pattern.test(value))) return null;
  if (!CONTACT_PATTERNS.some((pattern) => pattern.test(value))) return null;
  if (!PAYLOAD_PATTERNS.some((pattern) => pattern.test(value))) return null;
  return PRIVATE_CONTACT_BAIT;
}