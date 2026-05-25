/**
 * Summary: Orchestrates local memory persistence, multi-source recall, and
 * post-turn episodic extraction without exposing storage details to the LLM.
 */

import { createMessageId, createTimestamp } from '../types/messages.js';
import type {
  AgentCheckpoint,
  AgentSession,
  ContextInjection,
  DecisionEvent,
  JsonValue,
  KnowledgeSearchInput,
  KnowledgeSnippet,
  KnowledgeSource,
  MemoryEntry,
  MemoryExtractionInput,
  MemoryMetadataConfig,
  MemoryRecallInput,
  MemoryStore,
  Message,
  SummaryProvider,
  ToolChainReceipt,
  ToolMessage,
} from '../types/index.js';

export interface MemoryOrchestratorOptions {
  store: MemoryStore;
  sources?: KnowledgeSource[];
  summaryProvider?: SummaryProvider;
  metadata?: MemoryMetadataConfig;
  recallLimit?: number;
  extractionDirectory?: string;
  maxSummaryMessages?: number;
}

function sanitizeEntryId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

function summarizeText(text: string, maxLength = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function dedupeSnippets(snippets: KnowledgeSnippet[]): KnowledgeSnippet[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSnippet[] = [];

  for (const snippet of snippets) {
    const key = `${snippet.source}\0${snippet.id}\0${snippet.path ?? ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(snippet);
  }

  return deduped;
}

function buildToolReceipts(messages: Message[]): ToolChainReceipt[] {
  return messages
    .filter((message): message is ToolMessage => message.role === 'tool')
    .map((message) => ({
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      inputSummary: 'Captured from the current turn tool batch.',
      resultSummary: message.content.summary,
      isError: message.isError,
      ...(message.content.artifactId ? { artifactId: message.content.artifactId } : {}),
    }));
}

function buildDecisionEventMessage(decisionEvents: DecisionEvent[]): Message | undefined {
  if (decisionEvents.length === 0) {
    return undefined;
  }

  return {
    id: createMessageId('system'),
    role: 'system',
    createdAt: createTimestamp(),
    content: [
      'Decision events for the just-finished turn:',
      ...decisionEvents.map((event) => `- ${event.state} ${event.decision}: ${event.message}`),
    ].join('\n'),
  };
}

export class MemoryOrchestrator {
  constructor(private readonly options: MemoryOrchestratorOptions) {}

  async search(input: KnowledgeSearchInput, context?: { sessionId?: string; turnId?: string; signal?: AbortSignal }): Promise<KnowledgeSnippet[]> {
    const providers = [this.options.store, ...(this.options.sources ?? [])];
    const results = await Promise.all(providers.map((source) => source.search(input, context)));

    return dedupeSnippets(results.flat())
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit ?? 5);
  }

  async recall(input: MemoryRecallInput): Promise<ContextInjection[]> {
    const query = input.query.trim();
    if (query.length === 0) {
      return [];
    }

    const matches = await this.search(
      {
        query,
        limit: input.limit ?? this.options.recallLimit ?? 3,
      },
      {
        sessionId: input.session.id,
        turnId: input.session.turnId,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    return matches.map((match) => ({
      source: 'memory.recall',
      content: `${match.title}: ${match.excerpt}`,
    }));
  }

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    return this.options.store.save(entry);
  }

  async delete(id: string): Promise<boolean> {
    return this.options.store.delete(id);
  }

  async extractTurn(input: MemoryExtractionInput): Promise<MemoryEntry | undefined> {
    const messages = this.extractTurnMessages(input.session, input.previousTurnEndCheckpoint);
    const decisionEvents = input.checkpoint.decisionEvents.filter((event) => event.turnId === input.checkpoint.turnId);
    if (messages.length === 0 && decisionEvents.length === 0) {
      return undefined;
    }

    const receipts = buildToolReceipts(messages);
    const summary = await this.buildTurnSummary(input, messages, decisionEvents, receipts);
    if (summary.trim().length === 0) {
      return undefined;
    }

    const metadata = await this.resolveMetadata({
      session: input.session,
      checkpoint: input.checkpoint,
      summary,
      messages,
      decisionEvents,
    });

    return this.options.store.save({
      id: sanitizeEntryId(input.checkpoint.turnId),
      title: `Episode ${input.checkpoint.turnId}`,
      content: summary,
      source: 'episode',
      createdAt: input.checkpoint.createdAt,
      updatedAt: input.checkpoint.createdAt,
      path: `${this.options.extractionDirectory ?? 'episodes'}/${sanitizeEntryId(input.checkpoint.turnId)}.md`,
      metadata,
    });
  }

  private extractTurnMessages(session: AgentSession, previousTurnEndCheckpoint?: AgentCheckpoint): Message[] {
    const startIndex = previousTurnEndCheckpoint?.session.messages.length ?? 0;
    return session.messages.slice(startIndex);
  }

  private async buildTurnSummary(
    input: MemoryExtractionInput,
    messages: Message[],
    decisionEvents: DecisionEvent[],
    receipts: ToolChainReceipt[],
  ): Promise<string> {
    const limitedMessages = messages.slice(-(this.options.maxSummaryMessages ?? 16)).map((message) => {
      if (message.role !== 'tool') {
        return message;
      }

      // 工具消息在提炼阶段只保留 summary，避免把大块输出再次交给摘要模型。
      return {
        ...message,
        content: {
          ...message.content,
          text: message.content.summary,
        },
      } satisfies ToolMessage;
    });

    if (this.options.summaryProvider) {
      const decisionEventMessage = buildDecisionEventMessage(decisionEvents);
      const summaryMessages = decisionEventMessage
        ? [decisionEventMessage, ...limitedMessages]
        : limitedMessages;

      return this.options.summaryProvider.summarize({
        sessionId: input.session.id,
        messages: summaryMessages,
        receipts,
      });
    }

    return this.buildFallbackSummary(input.session, decisionEvents, receipts, limitedMessages);
  }

  private buildFallbackSummary(
    session: AgentSession,
    decisionEvents: DecisionEvent[],
    receipts: ToolChainReceipt[],
    messages: Message[],
  ): string {
    const bullets: string[] = [];
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUserMessage?.role === 'user') {
      bullets.push(`- User intent: ${summarizeText(lastUserMessage.content)}`);
    } else if (session.latestUserGoal) {
      bullets.push(`- User intent: ${summarizeText(session.latestUserGoal)}`);
    }

    if (receipts.length > 0) {
      bullets.push(...receipts.slice(-4).map((receipt) => `- Tool ${receipt.toolName}: ${receipt.resultSummary}`));
    }

    if (decisionEvents.length > 0) {
      bullets.push(...decisionEvents.slice(-4).map((event) => `- ${event.state} ${event.decision}: ${summarizeText(event.message, 120)}`));
    }

    if (bullets.length === 0) {
      bullets.push('- Turn completed with no durable memory candidates.');
    }

    return bullets.join('\n');
  }

  private async resolveMetadata(input: {
    session: AgentSession;
    checkpoint: AgentCheckpoint;
    summary: string;
    messages: Message[];
    decisionEvents: DecisionEvent[];
  }): Promise<Record<string, JsonValue>> {
    const resolvedMetadata = await this.options.metadata?.resolve?.(input);
    return {
      kind: 'episode',
      sessionId: input.session.id,
      turnId: input.checkpoint.turnId,
      createdAt: input.checkpoint.createdAt,
      ...(this.options.metadata?.defaults ?? {}),
      ...(resolvedMetadata ?? {}),
    };
  }
}