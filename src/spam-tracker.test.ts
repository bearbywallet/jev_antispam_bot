import { expect, test } from "bun:test";
import { SpamTracker, normalizeForDuplicateCheck } from "./spam-tracker";

test("normalizeForDuplicateCheck strips zero-width, normalizes unicode, and collapses whitespace", () => {
  expect(normalizeForDuplicateCheck("  Hello\u200B   World  ")).toBe("hello world");
  expect(normalizeForDuplicateCheck("ВХОД В КАЗИНО")).toBe("вход в казино");
});

test("detects duplicate messages within ttl window", () => {
  const tracker = new SpamTracker(60_000);
  tracker.recordMessage(100, "user:1", 1, "test message text", 1000);

  const check1 = tracker.checkDuplicate(100, "user:1", "test message text", 2, 2000);
  expect(check1.isDuplicate).toBe(true);
  expect(check1.duplicateCount).toBe(1);
  expect(check1.previousWasSpam).toBe(false);
  expect(check1.previousMessageIds).toEqual([1]);

  // Different sender
  expect(tracker.checkDuplicate(100, "user:2", "test message text", 2, 2000).isDuplicate).toBe(false);
  // Different chat
  expect(tracker.checkDuplicate(200, "user:1", "test message text", 2, 2000).isDuplicate).toBe(false);
  // Excluded messageId (same message)
  expect(tracker.checkDuplicate(100, "user:1", "test message text", 1, 2000).isDuplicate).toBe(false);
  // After TTL
  expect(tracker.checkDuplicate(100, "user:1", "test message text", 2, 62000).isDuplicate).toBe(false);
});

test("tracks spam strikes and flags duplicate of deleted spam", () => {
  const tracker = new SpamTracker(60_000);
  tracker.recordMessage(100, "user:1", 10, "@Tieaibot 涞码收小款", 1000);
  tracker.recordSpam(100, "user:1", 10, "@Tieaibot 涞码收小款", 1500);

  expect(tracker.getSpamCount(100, "user:1")).toBe(1);

  // Message 2 from same user with same text
  const check = tracker.checkDuplicate(100, "user:1", "@Tieaibot 涞码收小款", 11, 2000);
  expect(check.isDuplicate).toBe(true);
  expect(check.previousWasSpam).toBe(true);

  // Second spam recorded
  tracker.recordSpam(100, "user:1", 11, "@Tieaibot 涞码收小款", 2500);
  expect(tracker.getSpamCount(100, "user:1")).toBe(2);
});

test("ignores short conversational text without links or mentions", () => {
  const tracker = new SpamTracker(60_000);
  tracker.recordMessage(100, "user:1", 1, "да", 1000);
  expect(tracker.checkDuplicate(100, "user:1", "да", 2, 2000).isDuplicate).toBe(false);

  // Short text with bot mention IS eligible
  tracker.recordMessage(100, "user:1", 3, "@bot", 3000);
  expect(tracker.checkDuplicate(100, "user:1", "@bot", 4, 4000).isDuplicate).toBe(true);
});
