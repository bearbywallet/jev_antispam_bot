import { expect, test } from "bun:test";
import {
  APPROVED_MODEL,
  APPROVED_PROMPT_SHA256,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_VISION_MODEL,
  effectiveModel,
} from "./policy";
import { SPAM_QUESTIONS, systemPrompt } from "./spam";
import { cacheFingerprint } from "./spam-cache";
import { createHash } from "node:crypto";
import type { Message } from "grammy/types";

test("prompt pin matches the rendered OpenRouter system prompt", () => {
  expect(APPROVED_PROMPT_SHA256).toBe(createHash("sha256").update(systemPrompt()).digest("hex"));
  for (const key of Object.keys(SPAM_QUESTIONS)) expect(systemPrompt()).toContain(`[${key}]`);
});

test("approved classifier identity is pinned to the OpenRouter Jev model and OpenRouter vision fallbacks", () => {
  expect(APPROVED_MODEL).toBe("typesafe/jev-router");
  expect(DEFAULT_VISION_MODEL).toBe("nvidia/nemotron-3.5-super-vl:free");
  expect(DEFAULT_FALLBACK_MODELS).toEqual([
    "openrouter/free",
    "openai/gpt-oss-20b:free",
    "openai/gpt-oss-20b",
  ]);
  expect(effectiveModel("anything")).toBe("anything");
});

test("cache identity still separates fingerprints per model", () => {
  const raw = { message_id: 1, date: 1, chat: { id: -1, type: "group", title: "test" }, text: "long enough synthetic content" } as Message;
  const input = { text: raw.text!, embeddedLinks: [], isForwarded: false };
  expect(cacheFingerprint(raw, "user:1", input, 0, "model-a", .8, true)).not.toBe(cacheFingerprint(raw, "user:1", input, 0, "model-b", .8, true));
});

test("approved endpoint pin covers the routed slug, not the served engine", () => {
  // typesafe/jev-router rotates underlying engines by design: the response's
  // `model` field is informational, the pin covers the endpoint we call.
  expect(APPROVED_MODEL).toBe("typesafe/jev-router");
});
