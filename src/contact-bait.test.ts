import { describe, expect, test } from "bun:test";
import { PRIVATE_CONTACT_BAIT, privateContactBait } from "./contact-bait";
import { chinesePromotion, chinesePromotionControls } from "./fixtures/chinese-promotion";

describe("privateContactBait", () => {
  test("flags the reported terse Chinese data pitch", () => {
    // Exactly the message the group owner reported as not banned.
    expect(privateContactBait("去私信拿数据搞裙演  六栢一天  @KIRS150")).toBe(
      PRIVATE_CONTACT_BAIT,
    );
  });

  test("flags the Chinese mass-promotion ad that asks readers to DM for the full ad", () => {
    expect(privateContactBait(chinesePromotion)).toBe(PRIVATE_CONTACT_BAIT);
  });

  test("keeps every benign lookalike of the Chinese ad", () => {
    for (const control of chinesePromotionControls) {
      expect(privateContactBait(control)).toBeNull();
    }
  });

  test("flags Russian and English private-contact pitches", () => {
    expect(privateContactBait("Подробности в ЛС")).toBe(PRIVATE_CONTACT_BAIT);
    expect(privateContactBait("DM me for the price list")).toBe(PRIVATE_CONTACT_BAIT);
    expect(privateContactBait("write me in private and I will send the data")).toBe(
      PRIVATE_CONTACT_BAIT,
    );
  });

  test("keeps already-agreed coordination, warnings and empty text", () => {
    expect(privateContactBait("")).toBeNull();
    expect(privateContactBait("   ")).toBeNull();
    expect(privateContactBait("ordinary discussion")).toBeNull();
    expect(privateContactBait("В лс")).toBeNull();
    expect(privateContactBait("Я отправил тебе детали в личку, как ты просил.")).toBeNull();
    expect(privateContactBait("Напиши в ЛС, как договаривались.")).toBeNull();
    expect(privateContactBait("请不要联系广告里的机器人，有问题在群里讨论。")).toBeNull();
    expect(
      privateContactBait("转发一篇讨论：有人收到过自动推广引流的消息吗？请不要联系广告里的机器人。"),
    ).toBeNull();
  });
});