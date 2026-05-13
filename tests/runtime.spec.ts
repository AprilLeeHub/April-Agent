import { describe, expect, it } from 'vitest';

import { createAssistantMessage } from '../src/llm/provider.js';
import { createRuntime } from '../src/runtime/create-runtime.js';
import { smallModelSummaryConfig } from '../src/runtime/summary-model.config.js';
import type { Message, ProviderAdapter, ProviderRequest, ProviderResponse } from '../src/types/index.js';

class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly capabilities = { supportsToolCalls: true, supportsThinking: false, contextWindow: 1_024 };
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[] = []) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('not used');
    }

    return response;
  }

  estimateTokens(messages: Message[]): number {
    return messages.length;
  }
}

describe('createRuntime', () => {
  it('registers built-in tools into the runtime registry', () => {
    const runtime = createRuntime({
      provider: new FakeProvider(),
      model: 'fake-model',
      rootDir: process.cwd(),
    });

    expect(runtime.registry.snapshot().map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'grep_search',
      'bash',
    ]);
  });

  it('exposes a model-backed summary provider when summary config is supplied', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'summary from fake provider',
          finishReason: 'stop',
        }),
      },
    ]);
    const runtime = createRuntime({
      provider,
      model: 'fake-model',
      rootDir: process.cwd(),
      summary: {
        config: {
          ...smallModelSummaryConfig,
          model: 'summary-small-model',
        },
      },
    });

    expect(runtime.summaryProvider).toBeDefined();
    const summary = await runtime.summaryProvider?.summarize({
      sessionId: 'runtime-summary-1',
      messages: [{ id: 'u1', role: 'user', createdAt: new Date().toISOString(), content: 'hello' }],
      receipts: [],
    });

    expect(summary).toBe('summary from fake provider');
    expect(provider.requests[0]).toMatchObject({
      model: 'summary-small-model',
      tools: [],
      extra: smallModelSummaryConfig.extra,
    });
  });
});