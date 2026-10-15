export type TrackedMessage = {
  messageId: number;
  normalizedText: string;
  receivedAt: number;
  isSpam: boolean;
};

export function normalizeForDuplicateCheck(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type DuplicateCheckResult = {
  isDuplicate: boolean;
  duplicateCount: number;
  previousWasSpam: boolean;
  previousMessageIds: number[];
};

export class SpamTracker {
  private readonly activity = new Map<string, {
    messages: TrackedMessage[];
    spamCount: number;
    lastSpamAt?: number;
  }>();

  constructor(
    private readonly ttlMs = 24 * 3_600_000,
    private readonly maxMessages = 30,
  ) {
    const timer = setInterval(() => this.pruneExpired(Date.now()), Math.min(ttlMs, 300_000));
    timer.unref?.();
  }

  recordMessage(chatId: number, senderId: string, messageId: number, text: string, now = Date.now()): void {
    const key = `${chatId}:${senderId}`;
    const normalized = normalizeForDuplicateCheck(text);
    const current = this.activity.get(key) ?? { messages: [], spamCount: 0 };
    const recent = current.messages.filter((m) => now - m.receivedAt < this.ttlMs);
    const existing = recent.find((m) => m.messageId === messageId);
    if (existing) {
      existing.normalizedText = normalized;
      existing.receivedAt = now;
    } else {
      recent.push({ messageId, normalizedText: normalized, receivedAt: now, isSpam: false });
    }
    this.activity.set(key, { ...current, messages: recent.slice(-this.maxMessages) });
  }

  recordSpam(chatId: number, senderId: string, messageId: number, text: string, now = Date.now()): void {
    const key = `${chatId}:${senderId}`;
    const normalized = normalizeForDuplicateCheck(text);
    const current = this.activity.get(key) ?? { messages: [], spamCount: 0 };
    const recent = current.messages.filter((m) => now - m.receivedAt < this.ttlMs);
    const existing = recent.find((m) => m.messageId === messageId);
    if (existing) {
      existing.isSpam = true;
    } else {
      recent.push({ messageId, normalizedText: normalized, receivedAt: now, isSpam: true });
    }
    this.activity.set(key, {
      messages: recent.slice(-this.maxMessages),
      spamCount: current.spamCount + 1,
      lastSpamAt: now,
    });
  }

  checkDuplicate(chatId: number, senderId: string, text: string, excludeMessageId?: number, now = Date.now()): DuplicateCheckResult {
    const current = this.activity.get(`${chatId}:${senderId}`);
    if (!current) {
      return { isDuplicate: false, duplicateCount: 0, previousWasSpam: false, previousMessageIds: [] };
    }

    const normalized = normalizeForDuplicateCheck(text);
    const isEligible = normalized.length >= 6 || /@\w+|https?:\/\/|t\.me\//i.test(text);
    if (!isEligible) {
      return { isDuplicate: false, duplicateCount: 0, previousWasSpam: false, previousMessageIds: [] };
    }

    const matches = current.messages.filter(
      (m) => now - m.receivedAt < this.ttlMs && m.messageId !== excludeMessageId && m.normalizedText === normalized,
    );

    if (matches.length === 0) {
      return { isDuplicate: false, duplicateCount: 0, previousWasSpam: false, previousMessageIds: [] };
    }

    return {
      isDuplicate: true,
      duplicateCount: matches.length,
      previousWasSpam: matches.some((m) => m.isSpam),
      previousMessageIds: matches.map((m) => m.messageId),
    };
  }

  getSpamCount(chatId: number, senderId: string): number {
    return this.activity.get(`${chatId}:${senderId}`)?.spamCount ?? 0;
  }

  getRecentMessageCount(chatId: number, senderId: string, now = Date.now()): number {
    const messages = this.activity.get(`${chatId}:${senderId}`)?.messages ?? [];
    return messages.filter((m) => now - m.receivedAt < this.ttlMs).length;
  }

  getMessageIds(chatId: number, senderId: string): number[] {
    return (this.activity.get(`${chatId}:${senderId}`)?.messages ?? []).map((m) => m.messageId);
  }

  clear(chatId: number, senderId: string): void {
    this.activity.delete(`${chatId}:${senderId}`);
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.activity) {
      const recent = entry.messages.filter((m) => now - m.receivedAt < this.ttlMs);
      if (recent.length > 0 || (entry.lastSpamAt && now - entry.lastSpamAt < this.ttlMs)) {
        entry.messages = recent;
      } else {
        this.activity.delete(key);
      }
    }
  }
}
