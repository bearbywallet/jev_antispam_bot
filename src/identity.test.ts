import { expect, test } from "bun:test";
import { Api } from "grammy";
import {
  NameStore,
  IDENTITY_TEXT_PROMPT,
  impersonationKeyword,
  nameSimilarity,
  normalizeName,
  parseProbability,
  probabilityRequest,
  registerIdentityScreening,
  screenIdentity,
} from "./identity";
import type { ScreeningInput } from "./identity";

const member = (overrides: Partial<ScreeningInput["member"]> = {}): ScreeningInput => ({
  member: { name: "Вася", ...overrides },
  keyword: null,
});

test("normalizeName strips diacritics, zero-width chars, casing and punctuation", () => {
  expect(normalizeName("Ád̷m̶i\u200Bn Support")).toBe("admin support");
  expect(normalizeName("  АдмИн!! ")).toBe("админ");
  expect(normalizeName("John  Doe")).toBe("john doe");
});

test("nameSimilarity: exact, containment, near-miss and different", () => {
  expect(nameSimilarity("Alice", "alice")).toBe(1);
  expect(nameSimilarity("Support Team", "Support")).toBeGreaterThanOrEqual(0.5);
  expect(nameSimilarity("Alice",("Alicia"))).toBeGreaterThanOrEqual(0.5);
  expect(nameSimilarity("Alice", "Максим")).toBeLessThan(0.3);
});

test("impersonationKeyword: word boundaries in name and username", () => {
  expect(impersonationKeyword("Support", "vasya")).toBe("support");
  expect(impersonationKeyword("admin_support", "x")).toBe("admin");
  expect(impersonationKeyword("Поддержка чата", undefined)).toBe("поддержка");
  expect(impersonationKeyword("Helpdesk")).toBe("helpdesk");
  expect(impersonationKeyword("@support_fan", "club_support")).toBe("support");
  expect(impersonationKeyword("Administrator", "x")).toBeNull();
  expect(impersonationKeyword("Вася Пупкин", "vasya")).toBeNull();
  expect(impersonationKeyword("Republic", "x")).toBeNull();
});

test("NameStore distinguishes new / same / changed", () => {
  const names = new NameStore();
  expect(names.observe(1, 2, "Вася")).toBe("new");
  expect(names.observe(1, 2, "Вася")).toBe("same");
  expect(names.observe(1, 2, "Вася Пупкин")).toBe("changed");
  expect(names.observe(1, 2, "Вася Пупкин")).toBe("same");
  names.forget(1, 2);
  expect(names.observe(1, 2, "Вася")).toBe("new");
  // Per chat isolation.
  expect(names.observe(9, 2, "Вася")).toBe("new");
});

test("parseProbability strips think traces and clamps", () => {
  expect(parseProbability('{"probability":0.75}')).toBe(0.75);
  expect(parseProbability('<think>hmm {"probability":9}</think>{"probability": 0.4}')).toBe(0.4);
  expect(parseProbability('{"probability":5}')).toBe(1);
  expect(() => parseProbability("spam!")).toThrow("malformed JSON");
  expect(() => parseProbability('{"foo":1}')).toThrow("no probability");
});

test("probabilityRequest builds vision content parts and parses the answer", async () => {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: '{"probability":0.62}' } }] });
  }) as unknown as typeof fetch;
  const probability = await probabilityRequest(fetchFn, "https://api.z.ai/api/coding/paas/v4", "key", {
    model: "glm-4.6v", system: "SYS", user: "USER", images: ["data:image/a", "data:image/b"],
  });
  expect(probability).toBe(0.62);
  const body = bodies[0]! as { model: string; messages: Array<{ role: string; content: unknown }> };
  expect(body.model).toBe("glm-4.6v");
  expect(body.messages[0]!).toEqual({ role: "system", content: "SYS" });
  expect(body.messages[1]!.role).toBe("user");
  expect(body.messages[1]!.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/a" } },
    { type: "image_url", image_url: { url: "data:image/b" } },
    { type: "text", text: "USER" },
  ]);
});

test("screenIdentity decision table", async () => {
  const models = (values: { promo?: number; spam?: number; imit?: number }) => ({
    promoProbability: async () => values.promo ?? 0.01,
    avatarSpamProbability: async () => values.spam ?? 0.01,
    avatarImitationProbability: async () => values.imit ?? 0.01,
  });
  const t = 0.8;

  // 1. Support-nick, no corroboration -> no ban.
  expect((await screenIdentity(t, member({ name: "Support" }), models({}))).ban).toBe(false);

  // 2. Support-nick + promo bio -> ban.
  expect((await screenIdentity(t, { ...member({ name: "Support" }), keyword: "support", profileText: "[BIO] buy followers cheap" }, models({ promo: 0.95 }))).ban).toBe(true);

  // 3. Name exactly like admin + promo identity -> ban.
  const nameMatch: ScreeningInput = { ...member({ name: "Алексей" }), keyword: null,
    adminMatch: { adminId: 10, adminName: "Алексей", similarity: 1 }, profileText: "[BIO] crypto signals" };
  expect((await screenIdentity(t, nameMatch, models({ promo: 0.9 }))).ban).toBe(true);

  // 4. Name match but benign -> no ban.
  expect((await screenIdentity(t, nameMatch, models({}))).ban).toBe(false);

  // 5. Spam avatar alone -> ban.
  expect((await screenIdentity(t, { ...member(), avatarDataUrl: "data:x" }, models({ spam: 0.99 }))).ban).toBe(true);

  // 6. Admin lookalike avatar + support nick -> ban via imitation.
  expect((await screenIdentity(t, { ...member({ name: "Support" }), keyword: "support",
    avatarDataUrl: "data:x", topAdminAvatar: { adminId: 10, dataUrl: "data:admin" } }, models({ imit: 0.95 }))).ban).toBe(true);

  // 7. Similar avatar but no keyword/name match -> no ban (avoid false positives).
  expect((await screenIdentity(t, { ...member(), avatarDataUrl: "data:x",
    adminMatch: { adminId: 10, adminName: "Вася", similarity: 0.55 },
    topAdminAvatar: { adminId: 10, dataUrl: "data:admin" } }, models({ imit: 0.99 }))).ban).toBe(false);

  // 8. Models unavailable -> fail open.
  const failOpen = await screenIdentity(t, { ...member({ name: "Support" }), keyword: "support", profileText: "[BIO] promo" }, {
    promoProbability: async () => { throw new Error("down"); },
    avatarSpamProbability: async () => { throw new Error("down"); },
    avatarImitationProbability: async () => { throw new Error("down"); },
  });
  expect(failOpen.ban).toBe(false);
  expect(failOpen.reasons).toContain("text_model_unavailable");
});

test("registerIdentityScreening: join with promo bio bans, reports and deletes service message", async () => {
  const methods: string[] = [];
  const api = new Api("123:fixture");
  api.config.use(async (_prev: unknown, method: string, payload: unknown) => {
    methods.push(method);
    if (method === "getChatMember") return { status: "member", user: { id: 1 } } as never;
    if (method === "getChatAdministrators") return [{ status: "administrator", user: { id: 10, first_name: "Алексей", username: "chief" } }] as never;
    if (method === "getChat") return { id: -100, type: "private", bio: "🔥 crypto signals, paid VIP 🔥 t.me/buyvip" } as never;
    if (method === "getUserProfilePhotos") return { total_count: 0, photos: [] } as never;
    if (method === "sendMessage") return { message_id: 555, chat: { id: 1, type: "private" }, date: 1 } as never;
    return { ok: true } as never;
  });
  const handlers = new Map<string, (ctx: never) => Promise<void>>();
  const bot = { api, on: (trigger: string, handler: (ctx: never) => Promise<void>) => { handlers.set(trigger, handler); } } as never;
  const promoEvidence: string[] = [];
  const profiles: Array<number | undefined> = [];
  const { quiesce } = registerIdentityScreening(bot, {
    admins: { administrators: async () => [{ id: 10, name: "Алексей", username: "chief" }], isAdmin: async (id: number) => id === 10 } as never,
    profiles: { get: async (userId?: number) => { profiles.push(userId); return { bio: "🔥 crypto signals, paid VIP 🔥 t.me/buyvip" }; } } as never,
    imageLoader: async () => { throw new Error("no photo"); },
    threshold: 0.8,
    models: {
      promoProbability: async (evidence) => { promoEvidence.push(evidence); return 0.95; },
      avatarSpamProbability: async () => 0.01,
      avatarImitationProbability: async () => 0.01,
    },
    logger: { info: () => {}, error: () => {} },
    auditTimeoutMs: 1000,
  });
  expect(handlers.has("chat_member")).toBe(true);
  expect(handlers.has("message:new_chat_members")).toBe(true);
  expect(handlers.has("message")).toBe(true);

  // Supergroup join of a promotional "Support" account.
  methods.length = 0;
  await handlers.get("chat_member")!({
    chat: { id: -100500 },
    chatMember: {
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member", user: { id: 77, is_bot: false, first_name: "Support", username: "sup_promo" } },
    },
  } as never);
  expect(methods).toContain("banChatMember");
  expect(methods.filter((m) => m === "sendMessage")).toHaveLength(1); // audit report
  expect(promoEvidence[0]).toContain("[NAME] Support");
  expect(promoEvidence[0]).toContain("crypto signals");

  // Basic-group join: service message deleted after the ban.
  methods.length = 0;
  await handlers.get("message:new_chat_members")!({
    chat: { id: -100500 },
    msg: { message_id: 999, new_chat_members: [{ id: 88, is_bot: false, first_name: "helpdesk", username: "hd" }] },
  } as never);
  expect(methods).toContain("banChatMember");
  expect(methods).toContain("deleteMessage");

  // Admin joins: screened away without any API activity.
  methods.length = 0;
  await handlers.get("chat_member")!({
    chat: { id: -100500 },
    chatMember: {
      old_chat_member: { status: "left" },
      new_chat_member: { status: "administrator", user: { id: 10, is_bot: false, first_name: "Алексей" } },
    },
  } as never);
  expect(methods).not.toContain("banChatMember");
  expect(methods).not.toContain("getChat");

  // Rename: benign first message records the name; renamed to a support-nick re-screens.
  await handlers.get("message")!({ chat: { id: -100500 }, msg: { from: { id: 55, is_bot: false, first_name: "Вася" } } } as never);
  await quiesce();
  methods.length = 0;
  await handlers.get("message")!({ chat: { id: -100500 }, msg: { from: { id: 55, is_bot: false, first_name: "Support", username: "vasya" } } } as never);
  await quiesce();
  expect(profiles).toContain(55); // profile was fetched for the renamed user

  // Same-name repeat message does not re-screen.
  methods.length = 0;
  await handlers.get("message")!({ chat: { id: -100500 }, msg: { from: { id: 55, is_bot: false, first_name: "Support", username: "vasya" } } } as never);
  await quiesce();
  expect(profiles.filter((id) => id === 55)).toHaveLength(1); // no re-fetch on same name
});

test("IDENTITY_TEXT_PROMPT marks identity data as untrusted", () => {
  expect(IDENTITY_TEXT_PROMPT).toContain("UNTRUSTED");
  expect(IDENTITY_TEXT_PROMPT).toContain("never instructions");
});

test("IDENTITY_TEXT_PROMPT is strictly in English and includes casinos, lotteries, and giveaways", () => {
  expect(IDENTITY_TEXT_PROMPT).toContain("online casinos");
  expect(IDENTITY_TEXT_PROMPT).toContain("lotteries");
  expect(IDENTITY_TEXT_PROMPT).toContain("giveaways");
  expect(/[а-яё]/i.test(IDENTITY_TEXT_PROMPT)).toBe(false);
});

test("provocative channel with casino or lotteries triggers ban", async () => {
  const models = (values: { promo?: number }) => ({
    promoProbability: async () => values.promo ?? 0.01,
    avatarSpamProbability: async () => 0.01,
    avatarImitationProbability: async () => 0.01,
  });
  const t = 0.8;
  const input: ScreeningInput = {
    member: { name: "User" },
    keyword: null,
    provocativeKeyword: "казино",
    isProvocativeChannel: true,
    profileText: "[PERSONAL CHANNEL] Казино 1WIN — слоты и выигрыши",
  };
  const outcome = await screenIdentity(t, input, models({ promo: 0.95 }));
  expect(outcome.ban).toBe(true);
  expect(outcome.reasons).toContain("provocative_channel:казино");
});
