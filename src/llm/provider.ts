/**
 * Summary: Provider abstraction, response validation, and registry helpers that
 * keep vendor-specific request and response details out of the engine.
 */

import { assistantMessageSchema, createMessageId, createTimestamp, toolCallSchema } from '../types/messages.js';
import type { Message, ProviderAdapter, ProviderResponse, ProviderToolDefinition, ToolCall, ToolDefinition } from '../types/index.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider ${provider.name} is already registered.`);
    }

    this.providers.set(provider.name, provider);
  }

  get(name: string): ProviderAdapter {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider ${name} is not registered.`);
    }

    return provider;
  }
}

export function toProviderToolDefinitions(tools: ToolDefinition[]): ProviderToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  }));
}

export function createAssistantMessage(input: {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}): Extract<Message, { role: 'assistant' }> {
  return {
    id: createMessageId('assistant'),
    role: 'assistant',
    createdAt: createTimestamp(),
    content: input.content,
    ...(input.reasoningContent ? { reasoningContent: input.reasoningContent } : {}),
    ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
  };
}

export function assertProviderResponse(response: ProviderResponse): void {
  assistantMessageSchema.parse(response.assistant);

  for (const toolCall of response.assistant.toolCalls ?? []) {
    toolCallSchema.parse(toolCall);
  }
}