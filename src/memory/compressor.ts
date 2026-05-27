/**
 * Context compression module - P0 priority.
 *
 * Compresses conversation history to fit within token budget while
 * preserving key information needed for task continuity.
 */

export interface Message {
  role: string;
  content: string;
  tokenCount?: number;
  importance?: number;
}

export interface CompressionResult {
  messages: Message[];
  totalTokens: number;
  originalTokens: number;
  compressionRatio: number;
  tokensSaved: number;
}

/** Rough token estimation (4 chars ≈ 1 token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Abstract interface for context compression strategies.
 * Context compression is the highest priority operation (P0).
 */
export interface ContextCompressor {
  compress(messages: Message[], maxTokens: number): CompressionResult;
}

export interface SlidingWindowConfig {
  recentWindow?: number;
  importanceThreshold?: number;
}

/**
 * Compression via sliding window with importance-based retention.
 *
 * Strategy:
 * 1. Always keep the system message and latest N messages.
 * 2. For older messages, retain only those above importance threshold.
 * 3. Summarize dropped messages into a single condensed message.
 */
export class SlidingWindowCompressor implements ContextCompressor {
  private readonly recentWindow: number;
  private readonly importanceThreshold: number;

  constructor(config: SlidingWindowConfig = {}) {
    this.recentWindow = config.recentWindow ?? 5;
    this.importanceThreshold = config.importanceThreshold ?? 0.5;
  }

  compress(messages: Message[], maxTokens: number): CompressionResult {
    if (messages.length === 0) {
      return { messages: [], totalTokens: 0, originalTokens: 0, compressionRatio: 1.0, tokensSaved: 0 };
    }

    const getTokens = (m: Message) => m.tokenCount ?? estimateTokens(m.content);
    const originalTokens = messages.reduce((sum, m) => sum + getTokens(m), 0);

    // If already within budget, no compression needed
    if (originalTokens <= maxTokens) {
      return {
        messages: [...messages],
        totalTokens: originalTokens,
        originalTokens,
        compressionRatio: 1.0,
        tokensSaved: 0,
      };
    }

    // Split: system messages + recent window are protected
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const recent = nonSystem.length > this.recentWindow
      ? nonSystem.slice(-this.recentWindow)
      : [...nonSystem];
    const older = nonSystem.length > this.recentWindow
      ? nonSystem.slice(0, -this.recentWindow)
      : [];

    // Filter older messages by importance
    const importantOlder = older.filter(m => (m.importance ?? 1.0) >= this.importanceThreshold);
    const dropped = older.filter(m => (m.importance ?? 1.0) < this.importanceThreshold);

    // Build summary of dropped messages
    const summaryMsgs: Message[] = [];
    if (dropped.length > 0) {
      const summaryContent = `[Compressed ${dropped.length} earlier messages]`;
      summaryMsgs.push({
        role: 'system',
        content: summaryContent,
        tokenCount: estimateTokens(summaryContent),
        importance: 0.3,
      });
    }

    // Assemble final messages, trim from importantOlder if still over budget
    let resultMsgs = [...systemMsgs, ...summaryMsgs, ...importantOlder, ...recent];
    let total = resultMsgs.reduce((sum, m) => sum + getTokens(m), 0);

    const mutableImportant = [...importantOlder];
    while (total > maxTokens && mutableImportant.length > 0) {
      mutableImportant.shift();
      resultMsgs = [...systemMsgs, ...summaryMsgs, ...mutableImportant, ...recent];
      total = resultMsgs.reduce((sum, m) => sum + getTokens(m), 0);
    }

    const finalTokens = resultMsgs.reduce((sum, m) => sum + getTokens(m), 0);
    const ratio = originalTokens > 0 ? finalTokens / originalTokens : 1.0;

    return {
      messages: resultMsgs,
      totalTokens: finalTokens,
      originalTokens,
      compressionRatio: ratio,
      tokensSaved: originalTokens - finalTokens,
    };
  }
}
