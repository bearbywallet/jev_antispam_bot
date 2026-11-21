import { careControls, careInvitation, careRequest, careVariants, careWhitespaceVariants, laptopPreview, normalizedCare, photoCare, reportedCare, rvPreview } from "./fixtures/paid-care";
import { deletionMessageIds } from "./history";
import { DEFAULT_OPENROUTER_URL } from "./openrouter";
import { APPROVED_MODEL, DEFAULT_FALLBACK_MODELS } from "./policy";
import { CONTEXT_LINK_THRESHOLD, JevSpamClassifier, type ModerationMessage } from "./spam";

const laptop = normalizedCare(reportedCare, laptopPreview);
const rv = normalizedCare(reportedCare, rvPreview);
const photo = photoCare();
const requested = normalizedCare(reportedCare, careRequest);
// Reconstructed visible previews, not original Telegram payload identity.
// Histories deliberately retain earlier copies to measure recovery of missed spam.
export const careEvaluationCases: [string, ModerationMessage, ModerationMessage[]][] = [
  ["standalone", normalizedCare(), []], ["laptop", laptop, []],
  ["rv-repeat", rv, [laptop]], ["photo-third", photo, [laptop, rv]],
  ["requested", requested, []], ["requested-repeat", requested, [requested, requested]],
  ["invited", normalizedCare(reportedCare, careInvitation), []],
  ["mixed", photo, [requested, laptop, rv]],
  ...careWhitespaceVariants.map((text, i): [string, ModerationMessage, ModerationMessage[]] => ["whitespace-" + i, normalizedCare(text, laptopPreview), []]),
  ...careVariants.map((text, i): [string, ModerationMessage, ModerationMessage[]] => ["variant-" + i, normalizedCare(text, laptopPreview), []]),
  ...careControls.map((text, i): [string, ModerationMessage, ModerationMessage[]] => ["control-" + i, normalizedCare(text), []]),
  ["current-requested-after-unsolicited", requested, [laptop, rv]],
  ["requested-barrier", photo, [laptop, requested, rv]],
  ["photo-without-history", photo, []],
];

export async function evaluateCare(classifier: JevSpamClassifier, [name, message, history]: typeof careEvaluationCases[number]) {
  const result = await classifier.classify(message, history);
  if (result.contextProbabilities.length !== history.length) throw new Error("Incomplete linkage answers");
  const currentMessageId = history.length + 1;
  const selectedMessageIds = result.shouldDelete ? deletionMessageIds(
    history.map((item, index) => ({ ...item, messageId: index + 1, receivedAt: 1 })),
    currentMessageId, result.contextProbabilities, CONTEXT_LINK_THRESHOLD,
  ) : [];
  return { name, contextCount: history.length, currentMessageId, ...result, selectedMessageIds };
}

if (import.meta.main) {
  if (process.env.RUN_LIVE_OPENROUTER !== "1" || !process.env.OPENROUTER_API_KEY) {
    console.error("Opt in with RUN_LIVE_OPENROUTER=1 and an existing protected OPENROUTER_API_KEY environment.");
    process.exitCode = 1;
  } else {
    const classifier = new JevSpamClassifier(process.env.OPENROUTER_API_KEY, {
      model: process.env.OPENROUTER_MODEL?.trim() || APPROVED_MODEL,
      fallbackModels: DEFAULT_FALLBACK_MODELS,
      url: process.env.OPENROUTER_URL?.trim() || DEFAULT_OPENROUTER_URL,
      threshold: 0.9, timeoutMs: 10_000,
    });
    // One sequential attempt per case. No Telegram calls, source logging or retries.
    for (const fixture of careEvaluationCases) {
      try {
        console.log(JSON.stringify({ status: "parsed", threshold: 0.9, linkageThreshold: CONTEXT_LINK_THRESHOLD,
          ...await evaluateCare(classifier, fixture) }));
      } catch {
        console.log(JSON.stringify({ name: fixture[0], status: "failed", decision: "keep", selectedMessageIds: [] }));
        process.exitCode = 1;
      }
    }
  }
}
