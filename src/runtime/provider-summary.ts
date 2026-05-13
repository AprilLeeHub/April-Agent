/**
 * Summary: Model-backed summary provider that condenses older closed context
 * with a cheaper or smaller model before the main provider call.
 */

import { createMessageId, createTimestamp } from '../types/messages.js';
import type { Message, ProviderAdapter, SummaryModelConfig, SummaryProvider, ToolChainReceipt } from '../types/index.js';

const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  'You summarize earlier closed agent context for a coding agent.',
  'Return 4-8 concise bullet points.',
  'Preserve user goals, tool results, files, artifactIds, approvals, errors, and unresolved constraints.',
  'Do not invent facts or add new instructions.',
].join(' ');

export class ProviderSummaryProvider implements SummaryProvider {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly config: SummaryModelConfig,
  ) {}

  async summarize(input: {
    sessionId: string;
    messages: Message[];
    receipts: ToolChainReceipt[];
  }): Promise<string> {
    const response = await this.provider.generate({
      model: this.config.model,
      messages: [
        this.systemMessage(this.config.systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT),
        this.userMessage(this.buildSummaryPrompt(input.messages, input.receipts)),
      ],
      tools: [],
      signal: new AbortController().signal,
      ...(this.config.extra ? { extra: this.config.extra } : {}),
    });

    const summary = response.assistant.content.trim();
    return summary.length > 0 ? summary : this.fallbackSummary(input.receipts);
  }

  private buildSummaryPrompt(messages: Message[], receipts: ToolChainReceipt[]): string {
    const limitedMessages = messages.slice(-(this.config.maxSourceMessages ?? 40));
    const receiptSection = receipts.length > 0
      ? receipts.map((receipt) => this.formatReceipt(receipt)).join('\n')
      : '- none';
    const messageSection = limitedMessages.length > 0
      ? limitedMessages.map((message) => this.formatMessage(message)).join('\n')
      : '- none';

    return [
      'Summarize the earlier closed context for the next agent turn.',
      'Focus on durable facts only.',
      'Receipts:',
      receiptSection,
      'Messages:',
      messageSection,
    ].join('\n');
  }

  private formatReceipt(receipt: ToolChainReceipt): string {
    return [
      `- tool=${receipt.toolName}`,
      `input=${receipt.inputSummary}`,
      `result=${receipt.resultSummary}`,
      `error=${receipt.isError ? 'yes' : 'no'}`,
      ...(receipt.artifactId ? [`artifactId=${receipt.artifactId}`] : []),
    ].join(' | ');
  }

  private formatMessage(message: Message): string {
    if (message.role === 'tool') {
      return [
        `- tool ${message.toolName}`,
        `summary=${message.content.summary}`,
        ...(message.content.artifactId ? [`artifactId=${message.content.artifactId}`] : []),
      ].join(' | ');
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      return `- assistant toolCalls=${message.toolCalls.map((toolCall) => toolCall.name).join(', ')} | content=${message.content}`;
    }

    return `- ${message.role}: ${message.content}`;
  }

  private fallbackSummary(receipts: ToolChainReceipt[]): string {
    if (receipts.length === 0) {
      return '- Earlier closed context contained no durable receipts.';
    }

    return receipts
      .slice(-6)
      .map((receipt) => `- ${receipt.toolName}: ${receipt.resultSummary}`)
      .join('\n');
  }

  private systemMessage(content: string): Message {
    return {
      id: createMessageId('system'),
      role: 'system',
      createdAt: createTimestamp(),
      content,
    };
  }

  private userMessage(content: string): Message {
    return {
      id: createMessageId('user'),
      role: 'user',
      createdAt: createTimestamp(),
      content,
    };
  }
}