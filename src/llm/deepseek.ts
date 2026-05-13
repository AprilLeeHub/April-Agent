/**
 * Summary: DeepSeek provider adapter that maps the shared runtime request shape
 * to DeepSeek's OpenAI-compatible chat-completions payload.
 */

import { createAssistantMessage } from './provider.js';
import { createDeepSeekTokenCounter, type DeepSeekTokenCounter } from './deepseek-tokenizer.js';
import type { JsonValue, Message, ProviderAdapter, ProviderRequest, ProviderResponse, ToolCall } from '../types/index.js';

interface DeepSeekConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  tokenizerDir?: string;
  tokenCounter?: DeepSeekTokenCounter;
}

interface DeepSeekToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekResponse {
  choices?: Array<{
    finish_reason?: 'stop' | 'tool_calls' | 'length';
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class DeepSeekProvider implements ProviderAdapter {
  readonly name = 'deepseek';

  readonly capabilities = {
    supportsToolCalls: true,
    supportsThinking: true,
    contextWindow: 64_000,
  } as const;

  private readonly tokenCounter: DeepSeekTokenCounter | undefined;

  constructor(private readonly config: DeepSeekConfig) {
    this.tokenCounter = config.tokenCounter ?? (config.tokenizerDir ? createDeepSeekTokenCounter(config.tokenizerDir) : undefined);
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    const onAbort = () => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.config.baseUrl ?? 'https://api.deepseek.com'}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(this.createRequestBody(request)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const trimmedErrorBody = errorBody.trim();
        throw new Error(
          trimmedErrorBody
            ? `DeepSeek request failed with ${response.status} ${response.statusText}: ${trimmedErrorBody}`
            : `DeepSeek request failed with ${response.status} ${response.statusText}.`,
        );
      }

      const data = (await response.json()) as DeepSeekResponse;
      const choice = data.choices?.[0];
      if (!choice?.message) {
        throw new Error('DeepSeek response did not include a message choice.');
      }

      const toolCalls = choice.message.tool_calls?.map((toolCall) => this.parseToolCall(toolCall));
      return {
        assistant: createAssistantMessage({
          content: choice.message.content ?? '',
          ...(choice.message.reasoning_content ? { reasoningContent: choice.message.reasoning_content } : {}),
          ...(toolCalls?.length ? { toolCalls } : {}),
          finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
        }),
        raw: data,
        ...(data.usage
          ? {
              usage: {
                ...(data.usage.prompt_tokens !== undefined ? { inputTokens: data.usage.prompt_tokens } : {}),
                ...(data.usage.completion_tokens !== undefined ? { outputTokens: data.usage.completion_tokens } : {}),
              },
            }
          : {}),
      };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  estimateTokens(messages: Message[], extra?: Record<string, unknown>): number {
    if (this.tokenCounter) {
      return this.tokenCounter.countMessages(messages, extra);
    }

    const base = messages.reduce((count, message) => {
      const payload = message.role === 'tool' ? message.content.text : message.content;
      return count + Math.ceil(payload.length / 4);
    }, 0);

    return base + Math.ceil(JSON.stringify(extra ?? {}).length / 4);
  }

  describeTokenEstimate(): { source: string; mode: 'exact' | 'approximate' } {
    return this.tokenCounter?.describe() ?? {
      source: 'char_approx',
      mode: 'approximate',
    };
  }

  createRequestBody(request: ProviderRequest): Record<string, unknown> {
    const extra = request.extra ?? {};

    return {
      model: request.model || this.config.model,
      messages: request.messages.map((message) => this.mapMessage(message)),
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {
            type: 'object',
            properties: {},
          },
        },
      })),
      stream: false,
      ...(extra.thinking ? { thinking: extra.thinking } : {}),
      ...(extra.reasoning_effort !== undefined ? { reasoning_effort: extra.reasoning_effort } : {}),
      ...(extra.temperature !== undefined ? { temperature: extra.temperature } : {}),
      ...(extra.max_tokens !== undefined ? { max_tokens: extra.max_tokens } : {}),
    };
  }

  private mapMessage(message: Message): Record<string, unknown> {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content.text,
      };
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        })),
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(message.role === 'assistant' && message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}),
    };
  }

  private parseToolCall(toolCall: DeepSeekToolCall): ToolCall {
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      input: this.safeParseArguments(toolCall.function.arguments),
    };
  }

  private safeParseArguments(value: string): JsonValue {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return { raw: value };
    }
  }
}