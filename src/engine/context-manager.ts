/**
 * Summary: Provider-facing context construction with token budgeting, old tool
 * receipt compaction, and optional structured summary injection on safe edges.
 */

import { assertToolChainAdjacency, createMessageId, createTimestamp } from '../types/messages.js';
import type { ContextBuildResult, ContextInjection, JsonValue, Message, ProviderAdapter, SummaryProvider, ToolCall, ToolChainReceipt, ToolMessage } from '../types/index.js';
import { Observability } from './observability.js';

export interface ContextManagerOptions {
  maxTokens?: number;
  softWatermark?: number;
  hysteresis?: number;
  liveWindowSegments?: number;
}

interface BuildContextInput {
  sessionId: string;
  turnId: string;
  messages: Message[];
  contextInjections?: ContextInjection[];
  extra?: Record<string, unknown>;
  systemPrompt?: string;
  goal?: string;
  hardConstraints?: string[];
  stateSummary?: string;
}

export class ContextManager {
  private readonly summaryActive = new Map<string, boolean>();

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly observability: Observability,
    private readonly summaryProvider?: SummaryProvider,
    private readonly options: ContextManagerOptions = {},
  ) {}

  async build(input: BuildContextInput): Promise<ContextBuildResult> {
    assertToolChainAdjacency(input.messages);

    const injectedHead = this.buildInjectedHeadMessages(input);

    const maxTokens = this.options.maxTokens ?? this.provider.capabilities.contextWindow;
    const softWatermark = Math.floor(maxTokens * (this.options.softWatermark ?? 0.65));
    const hysteresisFloor = Math.floor(maxTokens * ((this.options.softWatermark ?? 0.65) - (this.options.hysteresis ?? 0.1)));
    const segments = this.segmentMessages(input.messages);
    const baseEstimate = this.provider.estimateTokens(input.messages, input.extra);

    let receipts: ToolChainReceipt[] = [];
    let microCompactionApplied = false;
    let workingSegments = segments;
    if (baseEstimate >= softWatermark || baseEstimate > maxTokens) {
      const compacted = this.applyMicroCompaction(segments);
      workingSegments = compacted.segments;
      receipts = compacted.receipts;
      microCompactionApplied = compacted.changed;
      this.observability[microCompactionApplied ? 'executed' : 'skipped'](
        input.sessionId,
        input.turnId,
        'compression.micro',
        microCompactionApplied ? 'Applied receipt compaction to older tool results.' : 'No eligible tool results for receipt compaction.',
      );
    } else {
      this.observability.skipped(input.sessionId, input.turnId, 'compression.micro', 'Context stays below compaction watermark.');
    }

    let requestMessages = [...injectedHead, ...workingSegments.flat()];
    const estimateAfterCompaction = this.provider.estimateTokens(requestMessages, input.extra);
    let summaryInjected = false;

    if (estimateAfterCompaction < hysteresisFloor) {
      this.summaryActive.set(input.sessionId, false);
    }

    if (
      this.summaryProvider
      && estimateAfterCompaction >= softWatermark
      && !this.summaryActive.get(input.sessionId)
    ) {
      const summarized = await this.applySummary(workingSegments, receipts, input);
      if (summarized) {
        requestMessages = summarized;
        summaryInjected = true;
        this.summaryActive.set(input.sessionId, true);
        this.observability.executed(input.sessionId, input.turnId, 'compression.summary', 'Injected structured summary for older closed context.');
      } else {
        this.observability.skipped(input.sessionId, input.turnId, 'compression.summary', 'No safe prefix was available for summary injection.');
      }
    } else {
      this.observability.skipped(
        input.sessionId,
        input.turnId,
        'compression.summary',
        !this.summaryProvider
          ? 'No summary provider configured for the soft watermark.'
          : estimateAfterCompaction < softWatermark
            ? 'Summary watermark not crossed after receipt compaction.'
            : 'Summary already active for this session.',
      );
    }

    assertToolChainAdjacency(requestMessages);
    return {
      requestMessages,
      receipts,
      summaryInjected,
      microCompactionApplied,
    };
  }

  private segmentMessages(messages: Message[]): Message[][] {
    const segments: Message[][] = [];

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }

      if (message.role === 'assistant' && message.toolCalls?.length) {
        const chainLength = 1 + message.toolCalls.length;
        segments.push(messages.slice(index, index + chainLength));
        index += message.toolCalls.length;
        continue;
      }

      segments.push([message]);
    }

    return segments;
  }

  private applyMicroCompaction(segments: Message[][]): {
    segments: Message[][];
    receipts: ToolChainReceipt[];
    changed: boolean;
  } {
    const liveWindowSegments = this.options.liveWindowSegments ?? 4;
    const systemPrefixCount = this.countLeadingSystemSegments(segments);
    const protectedStart = Math.max(systemPrefixCount, segments.length - liveWindowSegments);
    const receipts: ToolChainReceipt[] = [];
    let changed = false;

    const compactedSegments = segments.map((segment, index) => {
      if (index < systemPrefixCount || index >= protectedStart) {
        return segment.map((message) => structuredClone(message));
      }

      const firstMessage = segment[0];
      if (!firstMessage || firstMessage.role !== 'assistant' || !firstMessage.toolCalls?.length) {
        return segment.map((message) => structuredClone(message));
      }

      changed = true;
      const assistant = structuredClone(firstMessage);
      const toolMessages = segment.slice(1).map((message, offset) => {
        const toolMessage = message as ToolMessage;
        const toolCall = assistant.toolCalls?.[offset];
        const receipt = this.buildReceipt(toolMessage, toolCall);

        receipts.push(receipt);
        return {
          ...toolMessage,
          content: {
            text: `Compact receipt: ${receipt.resultSummary}`,
            summary: receipt.resultSummary,
            truncated: true,
            ...(receipt.artifactId ? { artifactId: receipt.artifactId } : {}),
            metadata: {
              compactReceipt: this.receiptToJson(receipt),
            },
          },
        } satisfies ToolMessage;
      });

      return [assistant, ...toolMessages];
    });

    return {
      segments: compactedSegments,
      receipts,
      changed,
    };
  }

  private buildReceipt(toolMessage: ToolMessage, toolCall?: ToolCall): ToolChainReceipt {
    return {
      toolCallId: toolMessage.toolCallId,
      toolName: toolMessage.toolName,
      inputSummary: toolCall ? this.summarize(JSON.stringify(toolCall.input)) : 'unknown input',
      resultSummary: toolMessage.content.summary || this.summarize(toolMessage.content.text),
      isError: toolMessage.isError,
      ...(toolMessage.content.artifactId ? { artifactId: toolMessage.content.artifactId } : {}),
    };
  }

  private async applySummary(segments: Message[][], receipts: ToolChainReceipt[], input: BuildContextInput): Promise<Message[] | undefined> {
    const liveWindowSegments = this.options.liveWindowSegments ?? 4;
    const systemPrefixCount = this.countLeadingSystemSegments(segments);
    const prefixEnd = Math.max(systemPrefixCount, segments.length - liveWindowSegments);
    const summarySource = segments.slice(systemPrefixCount, prefixEnd).flat();
    if (summarySource.length === 0) {
      return undefined;
    }

    const summary = await this.summaryProvider!.summarize({
      sessionId: input.sessionId,
      messages: summarySource,
      receipts,
    });

    const injectedHead = this.buildInjectedHeadMessages(input);
    const originalSystemMessages = segments.slice(0, systemPrefixCount).flat();
    const liveWindowMessages = segments.slice(prefixEnd).flat();

    return [
      ...injectedHead,
      ...originalSystemMessages,
      {
        id: createMessageId('summary'),
        role: 'system',
        createdAt: createTimestamp(),
        content: `Summary of earlier closed context:\n${summary}`,
      },
      ...liveWindowMessages,
    ];
  }

  private buildInjectedHeadMessages(input: BuildContextInput): Message[] {
    const messages: Message[] = [];

    if (input.systemPrompt) {
      messages.push(this.systemMessage(`System identity:\n${input.systemPrompt}`));
    }

    if (input.goal) {
      messages.push(this.systemMessage(`Current goal:\n${input.goal}`));
    }

    if (input.hardConstraints?.length) {
      messages.push(this.systemMessage(`Hard constraints:\n${input.hardConstraints.join('\n')}`));
    }

    if (input.stateSummary) {
      messages.push(this.systemMessage(`Runtime state:\n${input.stateSummary}`));
    }

    const contextInjections = this.dedupeContextInjections(input.contextInjections ?? []);
    const memoryInjections = contextInjections.filter((injection) => injection.source.startsWith('memory.'));
    const policyInjections = contextInjections.filter((injection) => !injection.source.startsWith('memory.'));

    if (memoryInjections.length > 0) {
      this.observability.executed(
        input.sessionId,
        input.turnId,
        'context.inject.memory',
        `Injected ${memoryInjections.length} memory recall snippet(s) into the provider request.`,
        {
          count: memoryInjections.length,
          sources: memoryInjections.map((injection) => injection.source),
        },
      );
      messages.push(this.systemMessage(`Memory recall:\n${memoryInjections.map((injection) => `- ${injection.content}`).join('\n')}`));
    } else {
      this.observability.skipped(input.sessionId, input.turnId, 'context.inject.memory', 'No memory recall snippets were pending for this request.');
    }

    if (policyInjections.length > 0) {
      this.observability.executed(
        input.sessionId,
        input.turnId,
        'context.inject',
        `Injected ${policyInjections.length} policy guidance hint(s) into the provider request.`,
        {
          count: policyInjections.length,
          sources: policyInjections.map((injection) => injection.source),
        },
      );
      messages.push(this.systemMessage(`Policy guidance:\n${policyInjections.map((injection) => `- ${injection.source}: ${injection.content}`).join('\n')}`));
    } else {
      this.observability.skipped(input.sessionId, input.turnId, 'context.inject', 'No policy guidance was pending for this request.');
    }

    return messages;
  }

  private dedupeContextInjections(contextInjections: ContextInjection[]): ContextInjection[] {
    const seen = new Set<string>();
    const deduped: ContextInjection[] = [];

    for (const injection of contextInjections) {
      const key = `${injection.source}\0${injection.content}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(injection);
    }

    return deduped;
  }

  private systemMessage(content: string): Message {
    return {
      id: createMessageId('system'),
      role: 'system',
      createdAt: createTimestamp(),
      content,
    };
  }

  private countLeadingSystemSegments(segments: Message[][]): number {
    let count = 0;
    while (true) {
      const segment = segments[count];
      const firstMessage = segment?.[0];
      if (!segment || segment.length !== 1 || !firstMessage || firstMessage.role !== 'system') {
        break;
      }

      count += 1;
    }

    return count;
  }

  private summarize(text: string, maxLength = 180): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
  }

  private receiptToJson(receipt: ToolChainReceipt): JsonValue {
    return {
      toolCallId: receipt.toolCallId,
      toolName: receipt.toolName,
      inputSummary: receipt.inputSummary,
      resultSummary: receipt.resultSummary,
      isError: receipt.isError,
      ...(receipt.artifactId ? { artifactId: receipt.artifactId } : {}),
    };
  }
}