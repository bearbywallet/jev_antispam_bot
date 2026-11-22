import type { SpamSignal } from "./spam";

/**
 * Deterministic strict moderation safety net for the highest-priority spam
 * families requested by group admins:
 *   1. 18+ / NSFW / explicit adult promotion
 *   2. Lotteries, raffles, giveaways, and gambling promotions
 *   3. Crypto airdrops, retrodrops, and token-claim lures
 *   4. Easy-earn / fast-money / passive-income lures
 *   5. Telegram invites whose public landing page is a zip/mega archive dump
 *
 * Each rule requires BOTH a category match AND a promotional/offer/CTA or
 * destination signal, and explicitly exempts scam warnings, moderator reports,
 * and pure informational questions without links or CTAs.
 */

export const STRICT_18_PLUS = "strict_18_plus" as const;
export const STRICT_LOTTERY = "strict_lottery" as const;
export const STRICT_AIRDROP = "strict_airdrop" as const;
export const STRICT_EASY_EARN = "strict_easy_earn" as const;
export const STRICT_ARCHIVE_INVITE = "strict_archive_invite" as const;

export type StrictRuleReason =
  | typeof STRICT_18_PLUS
  | typeof STRICT_LOTTERY
  | typeof STRICT_AIRDROP
  | typeof STRICT_EASY_EARN
  | typeof STRICT_ARCHIVE_INVITE;

export type StrictRuleMatch = {
  reason: StrictRuleReason;
  signal: SpamSignal;
};

const EXEMPTION_PATTERNS: readonly RegExp[] = [
  // English warnings, reports, moderation discussions.
  /\bthis\s+one\s+wasn'?t\s+recognized\b/i,
  /\bnot\s+recognized\s+as\s+spam\b/i,
  /\bwas\s+not\s+recognized\b/i,
  /\b(?:report|reporting|reported)\s+(?:this|it|to\s+mods?|spam|scam)\b/i,
  /\bplease\s+report\b/i,
  /\bmod(?:s|erators?)?,?\s+(?:please\s+)?(?:remove|delete|ban|check)\b/i,
  /\b(?:beware|warning|caution)\b.*\b(?:scam|spam|fraud|drainer|fake|phishing|don'?t\s+(?:join|click|connect|register|contact))\b/i,
  /\b(?:scam|fraud|wallet[\s-]*drainer|phishing)\s+(?:alert|warning|link|site|bot|channel)\b/i,
  /\bfake\s+(?:airdrop|giveaway|lottery|raffle|prize)\b/i,
  /\bdo\s+not\s+(?:join|click|connect|register|claim|trust|contact)\b/i,
  /\bdon'?t\s+(?:join|click|connect|register|claim|trust|contact)\b/i,
  // Russian warnings, reports, moderation discussions.
  /опять\s+рекламиру/iu,
  /не\s+(?:регистрируйт|переходит|отправляйт|подключайт|ведитесь|кликайт|доверяйт|верьт)/iu,
  /это\s+(?:спам|мошенник|мошенничеств|скам|развод|фейк|лохотрон)/iu,
  /похоже\s+на\s+(?:мошенничеств|скам|спам|развод)/iu,
  /осторожно[,:\s]/iu,
  /предупреждени[ея]/iu,
  /(?:разбираем|пример)\s+спам/iu,
  /модератор(?:ам|ы|у)?\s+(?:удалять|удалите|проверьте)/iu,
  /жалоба\s+на/iu,
  // German warnings.
  /\bWarnung(?:\s+vor\s+Spam)?\b/i,
  /\b(?:Betrug|Abzocke)\b/i,
  /\bNicht\s+(?:beitreten|klicken|registrieren)\b/i,
  // Chinese warnings/reports.
  /请不要(?:点击|联系|加入|注册|相信)/u,
  /不要(?:点击|注册|相信)/u,
  /骗子/u,
  /举报/u,
  /诈骗/u,
];

const URL_OR_HANDLE_PATTERN =
  /(?:https?:\/\/|t\.me\/|tg:\/\/|bit\.ly\/|tinyurl\.com\/|@\w{3,})/i;

const CTA_PATTERN = new RegExp(
  [
    // English CTAs.
    String.raw`\b(?:join|claim|participate|enter|grab|register|sign\s*up|subscribe|connect\s+(?:your\s+)?wallet|dm\s+me|pm\s+me|write\s+(?:me|us)|message\s+me|check\s+(?:my\s+)?(?:bio|profile|description)|link\s+in\s+(?:bio|profile)|tap\s+to\s+earn|click\s+here|start\s+earning)\b`,
    // Russian CTAs.
    String.raw`(?:забирай(?:те)?|участвуй(?:те)?|переходи(?:те)?|подписывай(?:ся|тесь)|регистрируй(?:ся|тесь)|вступай(?:те)?|присоединяй(?:ся|тесь)|подключай(?:те)?\s+кошел|клейм(?:и|ить)?|жми(?:те)?|пиши(?:те)?\s+(?:мне|нам|в\s+лс|в\s+личк)|подробности\s+в\s+(?:лс|личк|описани|профил|шапк)|ссылка\s+в\s+(?:профил|описани|шапк)|в\s+закрытый\s+канал|одноразов(?:ую|ая)\s+регистраци|успей(?:те)?)`,
    // Chinese CTAs.
    String.raw`(?:点击|领取|立即参与|马上注册|私信|私聊|进群|扫码)`,
  ].join("|"),
  "iu",
);

// 18+ / NSFW topic + offer/promotion patterns.
const ADULT_TOPIC_PATTERN = new RegExp(
  [
    String.raw`(?<![0-9])18\+`,
    String.raw`\b(?:nsfw|porn|porno|xxx|onlyfans|fansly|nudes?|sex\s*chat|sexcam|webcam|erotica|hentai|escort|hookup)\b`,
    String.raw`(?:порн[оу]|нюдс(?:ы|ов)?|интим(?:[\s-]*(?:услуг|фото|видео|чат|канал))?|эскорт|онлифанс|вебкам|клубничк[аиу]|эротик[аиу]|хентай|слив(?:ы|ов)?\s+(?:видео|фото|девушек|блогеров|интим|онлифанс|приват)|секс[\s-]*чат|проститут|индивидуалк)`,
    String.raw`(?:色情|裸聊|约炮|成人视频|黄片|福利姬)`,
  ].join("|"),
  "iu",
);

const ADULT_OFFER_PATTERN = new RegExp(
  [
    String.raw`\b(?:vip|private|closed|exclusive|paid|archive|leaks?|channel|group|bot|gallery|full\s+access|subscribe|register|nudes?|escort|cam|onlyfans|fansly)\b`,
    String.raw`(?:приват(?:ный|ка|ного)?|закрыт(?:ый|ого|ом)\s+канал|архив|слив|доступ|регистраци|подписк|платн|нюдс|интим|эскорт|вебкам|онлифанс|видео\s+без\s+цензур)`,
    String.raw`(?:私密|福利|进群|看片|视频)`,
  ].join("|"),
  "iu",
);

// Lotteries, raffles, giveaways, and gambling promotions.
const LOTTERY_TOPIC_PATTERN = new RegExp(
  [
    String.raw`\b(?:lottery|lotteries|raffle|raffles|giveaway|giveaways|sweepstakes|prize\s+draw|wheel\s+of\s+fortune|free\s+spins|jackpot|casino|slots|roulette|1win|1xbet|pin[\s-]?up|mostbet|melbet|fonbet|vulkan|stake\s+casino|bc\.game)\b`,
    String.raw`(?:лотере[яию]|розыгрыш|раффл|раздач[аеиу]\s+(?:денег|призов|звезд|звёзд|премиум|подарк|бонус)|халяв[аеу]|фриспин(?:ы|ов)?|джекпот|казино|слот(?:ы|ов)|рулетк[аиу]|колесо\s+фортуны|конкурс\s+на\s+деньги|промокод\s+на\s+бонус|бонус\s+на\s+депозит|драгон\s+мани|вулкан)`,
    String.raw`(?:抽奖|彩票|彩金|免费送钱|轮盘)`,
  ].join("|"),
  "iu",
);

const LOTTERY_OFFER_PATTERN = new RegExp(
  [
    String.raw`\b(?:win|prize|bonus|promo\s*code|deposit|free\s+spins|jackpot|giveaway|raffle|lottery|sweepstakes|reward|cash|usdt|ton|stars|premium|tickets?)\b`,
    String.raw`(?:выигр|приз|бонус|промокод|депозит|фриспин|джекпот|раздач|розыгрыш|лотере|раффл|билет|участв|забир|подар|кеш|кэш|usdt|ton|звезд|звёзд|премиум)`,
    String.raw`(?:赢取|奖金|奖励|免费|参与|彩金)`,
  ].join("|"),
  "iu",
);

// Crypto airdrops, retrodrops, and token claims.
const AIRDROP_TOPIC_PATTERN = new RegExp(
  [
    String.raw`\b(?:airdrops?|retrodrops?|token\s+drop|nft\s+drop|free\s+tokens?|free\s+crypto|tap[\s-]*to[\s-]*earn|claim\s+tokens?)\b`,
    String.raw`(?:аирдроп(?:ы|а|ов)?|эирдроп(?:ы|а|ов)?|ретродроп(?:ы|а|ов)?|раздач[аеиу]\s+(?:токен|крипт|монет|nft)|бесплатн(?:ые|ых)\s+токен|забери(?:те)?\s+дроп|тапалк[аиу])`,
    String.raw`(?:空投|免费领(?:代币|空投)|糖果空投)`,
  ].join("|"),
  "iu",
);

const AIRDROP_OFFER_PATTERN = new RegExp(
  [
    String.raw`\b(?:claim|eligible|eligibility|allocation|snapshot|connect\s+(?:your\s+)?wallet|presale|whitelist|referral|bonus|reward|free|grab|join|mint)\b`,
    String.raw`(?:клейм|забр|забир|получи|успей|аллокац|снимок|подключи(?:те)?\s+кошел|пресейл|вайтлист|реферал|бонус|наград|бесплатн|дроп)`,
    String.raw`(?:领取|连接钱包|白名单|奖励|免费)`,
  ].join("|"),
  "iu",
);

// Easy-earn / fast-money / passive-income schemes.
const EASY_EARN_TOPIC_PATTERN = new RegExp(
  [
    String.raw`\b(?:easy\s+earn|easy\s+money|fast\s+money|quick\s+cash|passive\s+income|daily\s+(?:profit|income|earnings?|payouts?|returns?)|make\s+money\s+(?:fast|online|daily|from\s+home)|guaranteed\s+(?:profit|income|returns?))\b`,
    String.raw`\bearn\s+(?:from\s+)?[$€£]?\d[\d\s,.]*\s*(?:[$€£]|usd|usdt|rub)?\s*(?:per|a|every|\/)\s*(?:day|hour|week)\b`,
    String.raw`(?:л[её]гк(?:ий|о|ого)\s+(?:заработ|доход)|быстр(?:ый|ого)\s+(?:заработ|доход|деньг)|прост(?:ой|ого)\s+заработ|пассивн(?:ый|ого)\s+доход|ежедневн(?:ые|ый)\s+(?:выплат|доход|прибыл)|хороший\s+заработок\s+от\s+\d|заработ(?:ок|ать)\s+(?:от\s+\d|с\s+телефона|без\s+опыта|на\s+дому|в\s+(?:день|сутки|час))|доход\s+от\s+\d[\d\s,.]*\s*(?:₽|руб|р\.?|usd|usdt|\$)?\s*(?:в\s+(?:день|сутки|час))|p2p\s+связк[аи]|вип[\s-]*сигнал|крипто[\s-]*сигнал)`,
    String.raw`(?:轻松赚钱|躺赚|日赚|日入|兼职日结)`,
  ].join("|"),
  "iu",
);

const EASY_EARN_OFFER_PATTERN = new RegExp(
  [
    String.raw`\b(?:guaranteed|no\s+experience|from\s+home|from\s+(?:your\s+)?phone|daily\s+payouts?|passive\s+income|vip\s+signals?|join|start|register|dm|pm|click|link|scheme|strategy)\b`,
    String.raw`(?:без\s+опыта|без\s+вложений|с\s+телефона|на\s+дому|гарант|выплат[аы]|пассивн|связк[аи]|сигнал|в\s+день|в\s+сутки|в\s+час|пиши|подробност|ссылк|канал|бот)`,
    String.raw`(?:无需经验|在家|日结|收益|私信|点击)`,
  ].join("|"),
  "iu",
);

const TELEGRAM_INVITE_PATTERN = /(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/|[A-Za-z0-9_]{4,})/i;

// Zip/mega dump channels advertise themselves on the public landing page
// ("Zips And Mega" / "Zipped archives and Mega links") while the group message
// is only the invite URL. Both words are required so a lone "archive" or
// "mega" mention is not enough.
function archiveDump(text: string): boolean {
  return /\b(?:zip(?:ped|s)?|archives?)\b/i.test(text) && /\bmega(?:\.nz)?\b/i.test(text);
}

export function strictRuleMatch(input: {
  text?: string;
  embeddedLinks?: readonly string[];
  inlineButtons?: readonly { text: string; url: string }[];
  /** Public title and description of a t.me landing page the current message links to. */
  destinationText?: string;
}): StrictRuleMatch | null {
  const rawText = (input.text ?? "").trim();
  const buttonLabels = (input.inlineButtons ?? []).map((b) => b.text).join(" ").trim();
  const combined = [rawText, buttonLabels].filter(Boolean).join(" ").trim();
  if (!combined && !(input.destinationText ?? "").trim()) return null;

  if (combined && EXEMPTION_PATTERNS.some((pattern) => pattern.test(combined))) {
    return null;
  }

  const hasDestination =
    (input.embeddedLinks?.length ?? 0) > 0 ||
    (input.inlineButtons?.length ?? 0) > 0 ||
    URL_OR_HANDLE_PATTERN.test(combined);
  const hasCta = CTA_PATTERN.test(combined);
  const isBareQuestion = /\?\s*$/.test(rawText) && !hasDestination && !hasCta;

  if (
    ADULT_TOPIC_PATTERN.test(combined) &&
    (hasDestination || hasCta || (!isBareQuestion && ADULT_OFFER_PATTERN.test(combined)))
  ) {
    return { reason: STRICT_18_PLUS, signal: "explicit_content_promotion" };
  }

  if (
    !isBareQuestion &&
    LOTTERY_TOPIC_PATTERN.test(combined) &&
    (hasDestination || hasCta || LOTTERY_OFFER_PATTERN.test(combined))
  ) {
    return { reason: STRICT_LOTTERY, signal: "lottery_or_giveaway_promotion" };
  }

  if (
    !isBareQuestion &&
    AIRDROP_TOPIC_PATTERN.test(combined) &&
    (hasDestination || hasCta || AIRDROP_OFFER_PATTERN.test(combined))
  ) {
    return { reason: STRICT_AIRDROP, signal: "airdrop_promotion" };
  }

  if (
    !isBareQuestion &&
    EASY_EARN_TOPIC_PATTERN.test(combined) &&
    (hasDestination || hasCta || EASY_EARN_OFFER_PATTERN.test(combined))
  ) {
    return { reason: STRICT_EASY_EARN, signal: "easy_money_bait" };
  }

  const inviteInMessage = TELEGRAM_INVITE_PATTERN.test([rawText, ...(input.embeddedLinks ?? [])].join(" "));
  const landing = (input.destinationText ?? "").trim();
  if (inviteInMessage && landing && archiveDump(landing)) {
    return { reason: STRICT_ARCHIVE_INVITE, signal: "unsolicited_telegram_invite_funnel" };
  }

  return null;
}
