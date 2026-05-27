/**
 * April-Agent Memory System
 *
 * A layered memory architecture with context compression, recall,
 * caching, and lifecycle management.
 */

export { TokenBudget } from './memory/tokenBudget';
export type { TokenBudgetConfig } from './memory/tokenBudget';

export { SlidingWindowCompressor, estimateTokens } from './memory/compressor';
export type { ContextCompressor, Message, CompressionResult, SlidingWindowConfig } from './memory/compressor';

export { ProjectContextStore, projectContextToString } from './memory/projectContext';
export type { ProjectContext } from './memory/projectContext';

export { KnowledgeEntry, KnowledgeStore, KnowledgeSource, KnowledgeStatus } from './memory/knowledge';
export type { KnowledgeEntryData, KnowledgeQuery } from './memory/knowledge';

export { MemoryRecaller, defaultSimilarity, userPreferencesToString, recalledContextToMessages, RECALL_THRESHOLD } from './memory/recall';
export type { UserPreferences, RecalledContext, RecallOptions, SimilarityFn } from './memory/recall';

export { SessionCache, CrossSessionCache } from './memory/cache';

export { KnowledgeCleaner, cleanupReportSummary } from './memory/cleanup';
export type { CleanupReport, ContradictionFn, KnowledgeCleanerConfig } from './memory/cleanup';
