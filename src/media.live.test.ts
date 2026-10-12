import { expect, test } from "bun:test";
import { JevSpamClassifier } from "./spam";
import { mediaFixtures, mediaMessage } from "./fixtures/media-profile";

const key = process.env.ZAI_API_KEY;
const liveTest = process.env.RUN_LIVE_ZAI === "1" && key ? test : test.skip;
const classifier = new JevSpamClassifier(key ?? "unused", { model: "glm-4.6v", threshold: 0.9, timeoutMs: 25_000 });
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
