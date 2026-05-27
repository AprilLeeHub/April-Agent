/**
 * Memory recall module - P2 priority.
 *
 * Implements the session-start recall strategy:
 * - L0 (Project Context): Always recalled
 * - L1 (User Preferences): Always recalled
 * - L2 (Task Patterns): Conditional, similarity-based
 * - L3 (Deep Knowledge): Only on explicit trigger
 */

import { ProjectContext, ProjectContextStore, projectContextToString } from './projectContext';
import { KnowledgeEntry, KnowledgeStore, KnowledgeStatus } from './knowledge';
import { TokenBudget } from './tokenBudget';
import { Message, estimateTokens } from './compressor';

export const RECALL_THRESHOLD = 0.3;

export interface UserPreferences {
  userId: string;
  language?: string;
  responseStyle?: string;
  custom?: Record<string, string>;
}

export function userPreferencesToString(prefs: UserPreferences): string {
  const parts: string[] = [`User preferences (user=${prefs.userId}):`];
  parts.push(`  Language: ${prefs.language ?? 'zh'}`);
  parts.push(`  Style: ${prefs.responseStyle ?? 'detailed'}`);
  if (prefs.custom) {
    for (const [k, v] of Object.entries(prefs.custom)) {
      parts.push(`  ${k}: ${v}`);
    }
  }
  return parts.join('\n');
}

export interface RecalledContext {
  projectContext: ProjectContext | null;
  userPreferences: UserPreferences | null;
  taskPatterns: KnowledgeEntry[];
  totalTokensUsed: number;
}

/** Convert recalled context into messages for prompt injection. */
export function recalledContextToMessages(ctx: RecalledContext): Message[] {
  const messages: Message[] = [];
  if (ctx.projectContext) {
    const content = projectContextToString(ctx.projectContext);
    messages.push({
      role: 'system',
      content: `[Project Context]\n${content}`,
      tokenCount: estimateTokens(content),
      importance: 1.0,
    });
  }
  if (ctx.userPreferences) {
    const content = userPreferencesToString(ctx.userPreferences);
    messages.push({
      role: 'system',
      content: `[User Preferences]\n${content}`,
      tokenCount: estimateTokens(content),
      importance: 0.9,
    });
  }
  for (const entry of ctx.taskPatterns) {
    messages.push({
      role: 'system',
      content: `[Recalled Knowledge]\n${entry.content}`,
      tokenCount: estimateTokens(entry.content),
      importance: entry.currentValue,
    });
  }
  return messages;
}

export type SimilarityFn = (query: string, content: string) => number;

/** Simple keyword overlap similarity (placeholder for embeddings). */
export function defaultSimilarity(query: string, content: string): number {
  if (!query || !content) return 0;
  const queryWords = new Set(query.toLowerCase().split(/\s+/));
  const contentWords = new Set(content.toLowerCase().split(/\s+/));
  if (queryWords.size === 0) return 0;
  let overlap = 0;
  for (const w of queryWords) {
    if (contentWords.has(w)) overlap++;
  }
  return overlap / queryWords.size;
}

export interface RecallOptions {
  projectId: string;
  userPrefs?: UserPreferences;
  firstMessage?: string;
  compressedTokens?: number;
  topK?: number;
}

export class MemoryRecaller {
  private readonly projectStore: ProjectContextStore;
  private readonly knowledgeStore: KnowledgeStore;
  private readonly tokenBudget: TokenBudget;
  private readonly similarityFn: SimilarityFn;

  constructor(
    projectStore: ProjectContextStore,
    knowledgeStore: KnowledgeStore,
    tokenBudget: TokenBudget,
    similarityFn?: SimilarityFn,
  ) {
    this.projectStore = projectStore;
    this.knowledgeStore = knowledgeStore;
    this.tokenBudget = tokenBudget;
    this.similarityFn = similarityFn ?? defaultSimilarity;
  }

  /**
   * Execute session-start memory recall.
   */
  recall(options: RecallOptions): RecalledContext {
    const { projectId, userPrefs, firstMessage, compressedTokens = 0, topK = 3 } = options;
    const availableTokens = this.tokenBudget.remainingForMemory(compressedTokens);
    let tokensUsed = 0;

    const result: RecalledContext = {
      projectContext: null,
      userPreferences: null,
      taskPatterns: [],
      totalTokensUsed: 0,
    };

    // L0: Always recall project context
    const projectCtx = this.projectStore.get(projectId);
    if (projectCtx) {
      const ctxTokens = estimateTokens(projectContextToString(projectCtx));
      if (tokensUsed + ctxTokens <= availableTokens) {
        result.projectContext = projectCtx;
        tokensUsed += ctxTokens;
      }
    }

    // L1: Always recall user preferences
    if (userPrefs) {
      const prefTokens = estimateTokens(userPreferencesToString(userPrefs));
      if (tokensUsed + prefTokens <= availableTokens) {
        result.userPreferences = userPrefs;
        tokensUsed += prefTokens;
      }
    }

    // L2: Conditional recall of task patterns
    if (firstMessage) {
      const candidates = this.knowledgeStore.query({
        projectId,
        status: KnowledgeStatus.Active,
        minValue: 0.1,
      });

      const scored: Array<{ score: number; entry: KnowledgeEntry }> = [];
      for (const entry of candidates) {
        const sim = this.similarityFn(firstMessage, entry.content);
        if (sim >= RECALL_THRESHOLD) {
          scored.push({ score: sim * entry.currentValue, entry });
        }
      }
      scored.sort((a, b) => b.score - a.score);

      for (const { entry } of scored.slice(0, topK)) {
        const entryTokens = estimateTokens(entry.content);
        if (tokensUsed + entryTokens > availableTokens) break;
        entry.access();
        result.taskPatterns.push(entry);
        tokensUsed += entryTokens;
      }
    }

    // L3: Not recalled at startup (explicit trigger only)

    result.totalTokensUsed = tokensUsed;
    return result;
  }
}
