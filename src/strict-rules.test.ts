import { describe, expect, test } from "bun:test";
import {
  STRICT_18_PLUS,
  STRICT_AIRDROP,
  STRICT_ARCHIVE_INVITE,
  STRICT_EASY_EARN,
  STRICT_LOTTERY,
  strictRuleMatch,
} from "./strict-rules";
import { chinesePromotionControls } from "./fixtures/chinese-promotion";
import { cryptoRecoveryControls } from "./fixtures/crypto-recovery";
import { inviteControls } from "./fixtures/invite-funnel";
import { investmentTestimonialControls } from "./fixtures/investment-testimonial";
import { testimonialControls } from "./fixtures/testimonial-promotion";

describe("strictRuleMatch", () => {
  test("catches 18+ / NSFW promotions across English, Russian, Chinese, and inline buttons", () => {
    expect(strictRuleMatch({ text: "Hot 18+ leaks and NSFW videos in my VIP channel https://t.me/vip18" })).toEqual({
      reason: STRICT_18_PLUS,
      signal: "explicit_content_promotion",
    });
    expect(strictRuleMatch({ text: "OnlyFans сливы, приватный архив 18+, вход по ссылке @hot_leaks_bot" })).toEqual({
      reason: STRICT_18_PLUS,
      signal: "explicit_content_promotion",
    });
    expect(strictRuleMatch({ text: "Свежие порно видео и интим чат, переходи в закрытый канал" })).toEqual({
      reason: STRICT_18_PLUS,
      signal: "explicit_content_promotion",
    });
    expect(strictRuleMatch({
      text: "Check it out",
      inlineButtons: [{ text: "18+ VIP Access", url: "https://t.me/adult_vip" }],
    })).toEqual({
      reason: STRICT_18_PLUS,
      signal: "explicit_content_promotion",
    });
  });

  test("catches lotteries, raffles, giveaways, and gambling promotions", () => {
    expect(strictRuleMatch({ text: "Huge USDT giveaway & raffle! Join now to win $1000: https://t.me/+promo" })).toEqual({
      reason: STRICT_LOTTERY,
      signal: "lottery_or_giveaway_promotion",
    });
    expect(strictRuleMatch({ text: "Лотерея и розыгрыш 50000 рублей! Забирай фриспины и бонус на депозит по промокоду WIN" })).toEqual({
      reason: STRICT_LOTTERY,
      signal: "lottery_or_giveaway_promotion",
    });
    expect(strictRuleMatch({ text: "Раздача денег и звёзд Telegram! Участвуй в розыгрыше @prize_bot" })).toEqual({
      reason: STRICT_LOTTERY,
      signal: "lottery_or_giveaway_promotion",
    });
    expect(strictRuleMatch({
      text: "Special offer",
      embeddedLinks: ["https://example.invalid/casino"],
      inlineButtons: [{ text: "Claim Giveaway Prize", url: "https://example.invalid/casino" }],
    })).toEqual({
      reason: STRICT_LOTTERY,
      signal: "lottery_or_giveaway_promotion",
    });
  });

  test("catches crypto airdrops, retrodrops, and token-claim lures", () => {
    expect(strictRuleMatch({ text: "New token airdrop is live! Connect your wallet to claim free tokens: https://claim.example" })).toEqual({
      reason: STRICT_AIRDROP,
      signal: "airdrop_promotion",
    });
    expect(strictRuleMatch({ text: "Аирдроп и ретродроп токенов — подключай кошелек и забирай дроп @drop_claim_bot" })).toEqual({
      reason: STRICT_AIRDROP,
      signal: "airdrop_promotion",
    });
    expect(strictRuleMatch({ text: "Tap to earn free crypto airdrop! Join my referral link https://t.me/tap_bot" })).toEqual({
      reason: STRICT_AIRDROP,
      signal: "airdrop_promotion",
    });
    expect(strictRuleMatch({ text: "免费领空投代币，立即领取 https://airdrop.example" })).toEqual({
      reason: STRICT_AIRDROP,
      signal: "airdrop_promotion",
    });
  });

  test("catches easy-earn, passive-income, and fast-money schemes", () => {
    expect(strictRuleMatch({ text: "Earn guaranteed easy money every day! Join my earning group: https://t.me/+ExampleInvite" })).toEqual({
      reason: STRICT_EASY_EARN,
      signal: "easy_money_bait",
    });
    expect(strictRuleMatch({ text: "Easy earn from home! Make $500 per day with no experience, DM me" })).toEqual({
      reason: STRICT_EASY_EARN,
      signal: "easy_money_bait",
    });
    expect(strictRuleMatch({ text: "Быстрый заработок с телефона без опыта! Пассивный доход от 5000 в день, пиши в лс" })).toEqual({
      reason: STRICT_EASY_EARN,
      signal: "easy_money_bait",
    });
    expect(strictRuleMatch({ text: "轻松赚钱日赚500元，私信领取项目" })).toEqual({
      reason: STRICT_EASY_EARN,
      signal: "easy_money_bait",
    });
  });

  test("exempts genuine questions, ordinary salary talk, scam warnings, and moderator reports", () => {
    const benignMessages = [
      "Is there an official Bearby airdrop?",
      "Did anyone get the ZIL airdrop last year?",
      "Did anyone win the state lottery last night?",
      "How does passive income work in DeFi staking?",
      "Моя зарплата выросла до 5000 рублей в сутки после повышения.",
      "В группе опять рекламируют закрытый канал со сливами — не регистрируйтесь, это спам.",
      "Обсуждаем, как модераторам удалять рекламу сексуального контента из чата.",
      "Casino.ru — это казино; не переходите по ссылке, похоже на мошенничество.",
      "Warning: this airdrop link is a wallet drainer scam, do not connect your wallet!",
      "Beware of fake giveaway bots asking you to join https://t.me/fake",
      "this one wasn't recognized: Claim free airdrop tokens now!",
      "Here is my channel, as requested: https://t.me/synthetic_channel",
      "This profile is advertising private adult videos; please report it.",
      "Mods, please delete this 18+ spam link",
      ...chinesePromotionControls,
      ...investmentTestimonialControls,
      ...cryptoRecoveryControls.map((c) => c.text),
      ...testimonialControls.map((c) => c.text),
      ...inviteControls.map((c) => c.text),
    ];

    for (const text of benignMessages) {
      expect(strictRuleMatch({ text })).toBeNull();
    }
  });

  test("deletes a bare invite whose landing page is a zip and mega dump", () => {
    const landing = "🔥 Zips And Mega\nZipped archives and Mega links";
    expect(strictRuleMatch({
      text: "https://t.me/+VCIsBqKNIs45YTg5",
      destinationText: landing,
    })).toEqual({
      reason: STRICT_ARCHIVE_INVITE,
      signal: "unsolicited_telegram_invite_funnel",
    });
    expect(strictRuleMatch({
      text: "Don't join this spam https://t.me/+VCIsBqKNIs45YTg5",
      destinationText: landing,
    })).toBeNull();
    expect(strictRuleMatch({
      text: "https://t.me/+VCIsBqKNIs45YTg5",
      destinationText: "Study group for books",
    })).toBeNull();
    expect(strictRuleMatch({
      text: "I zipped the archive and uploaded it to mega https://mega.nz/file/abc",
    })).toBeNull();
  });
});
