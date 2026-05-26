import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createAssistantMessage } from '../src/llm/provider.js';
import { createRuntime } from '../src/runtime/create-runtime.js';
import { memoryExtractionConfig } from '../src/config/memory-extraction.config.js';
import { smallModelSummaryConfig } from '../src/config/summary-model.config.js';
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

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function eventually(assertion: () => Promise<void>, attempts = 20): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }

  throw lastError;
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

  it('registers memory tools and injects memory recall when memory is enabled', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-runtime-memory-'));
    tempDirs.push(rootDir);
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'Recovered the earlier fix and answered the user.',
          finishReason: 'stop',
        }),
      },
      {
        assistant: createAssistantMessage({
          content: '- Durable memory: vite build fix recalled and persisted.',
          finishReason: 'stop',
        }),
      },
    ]);
    const runtime = createRuntime({
      provider,
      model: 'fake-model',
      rootDir,
      memory: {},
    });

    expect(runtime.registry.snapshot().map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'grep_search',
      'search_knowledge',
      'save_to_memory',
      'delete_from_memory',
      'bash',
    ]);

    await runtime.memoryOrchestrator?.save({
      id: 'vite-fix',
      title: 'Vite Build Fix',
      content: 'Align tsconfig paths and clean stale build output before rerunning the build.',
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        tags: ['vite', 'build'],
      },
    });

    await runtime.engine.submitUserInput('runtime-memory-session', 'How did we fix vite build?');
    await runtime.engine.confirmTurn('runtime-memory-session');
    const completed = await runtime.engine.runTurn('runtime-memory-session');

    expect(completed.status).toBe('completed');

    const memoryMessage = provider.requests[0]?.messages.find(
      (message) => message.role === 'system' && message.content.startsWith('Memory recall:'),
    );
    expect(memoryMessage?.content).toContain('Vite Build Fix');

    await eventually(async () => {
      const matches = await runtime.memoryOrchestrator?.search({ query: 'runtime-memory-session turn 0', limit: 10 });
      expect(matches?.some((match) => match.path?.includes('/episodes/'))).toBe(true);
    });
  });

  it('uses the dedicated extraction model for episodic memory summarization', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-runtime-memory-llm-'));
    tempDirs.push(rootDir);
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'Primary answer from the main model.',
          finishReason: 'stop',
        }),
      },
      {
        assistant: createAssistantMessage({
          content: '- Durable memory: flash extraction summary',
          finishReason: 'stop',
        }),
      },
    ]);
    const runtime = createRuntime({
      provider,
      model: 'fake-model',
      rootDir,
      memory: {},
    });

    await runtime.engine.submitUserInput('runtime-memory-llm-session', 'Summarize this turn and keep a durable memory.');
    await runtime.engine.confirmTurn('runtime-memory-llm-session');
    const completed = await runtime.engine.runTurn('runtime-memory-llm-session');

    expect(completed.status).toBe('completed');

    await eventually(async () => {
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]).toMatchObject({
        model: memoryExtractionConfig.model,
        tools: [],
        extra: memoryExtractionConfig.extra,
      });
    });

    await eventually(async () => {
      const matches = await runtime.memoryOrchestrator?.search({ query: 'flash extraction summary', limit: 5 });
      expect(matches?.some((match) => match.content.includes('flash extraction summary'))).toBe(true);
    });
  });
});