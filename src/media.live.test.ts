import { expect, test } from "bun:test";
import { DEFAULT_OPENROUTER_URL } from "./openrouter";
import { DEFAULT_FALLBACK_MODELS, DEFAULT_VISION_MODEL } from "./policy";
import { JevSpamClassifier } from "./spam";
import { mediaFixtures, mediaMessage } from "./fixtures/media-profile";

const key = process.env.OPENROUTER_API_KEY;
const liveTest = process.env.RUN_LIVE_OPENROUTER === "1" && key ? test : test.skip;
const classifier = new JevSpamClassifier(key ?? "unused", {
  model: process.env.OPENROUTER_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
  fallbackModels: DEFAULT_FALLBACK_MODELS,
  url: process.env.OPENROUTER_URL?.trim() || DEFAULT_OPENROUTER_URL,
  threshold: 0.9, timeoutMs: 25_000,
});
for (const isForwarded of [false, true]) {
  for (const fixture of mediaFixtures) {
    liveTest(fixture.id + " forwarded=" + isForwarded, async () => {
      const recent = fixture.recent ?? [];
      const result = await classifier.classify(mediaMessage(fixture, isForwarded), recent);
      console.info(JSON.stringify({ fixture: fixture.id, isForwarded, probability: result.probability, shouldDelete: result.shouldDelete }));
      expect(result.contextProbabilities).toHaveLength(recent.length);
      expect(result.shouldDelete).toBe(fixture.shouldDelete);
      expect(result.strongestSignal).toBe("media_profile_funnel");
    }, 15_000);
  }
}
