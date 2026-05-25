import { describe, expect, it } from 'vitest';

import { ContextManager } from '../src/engine/context-manager.js';
import { Observability } from '../src/engine/observability.js';
import { createAssistantMessage } from '../src/llm/provider.js';
import { createToolResultMessage } from '../src/types/messages.js';
import type { Message, ProviderAdapter, ProviderRequest, ProviderResponse, SummaryProvider } from '../src/types/index.js';

class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly capabilities = { supportsToolCalls: true, supportsThinking: false, contextWindow: 120 };

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('not used in this test');
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((count, message) => {
      const content = message.role === 'tool' ? message.content.text : message.content;
      return count + content.length;
    }, 0);
  }
}

describe('ContextManager', () => {
  it('compacts old closed tool results without breaking assistant-tool adjacency', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    const manager = new ContextManager(provider, observability, undefined, { maxTokens: 120, liveWindowSegments: 2 });
    const assistant = createAssistantMessage({
      content: 'need a tool',
      toolCalls: [{ id: 'call-1', name: 'search', input: { q: 'alpha' } }],
      finishReason: 'tool_calls',
    });
    const messages: Message[] = [
      { id: 'sys-1', role: 'system', createdAt: new Date().toISOString(), content: 'system' },
      { id: 'user-1', role: 'user', createdAt: new Date().toISOString(), content: 'old question' },
      assistant,
      createToolResultMessage('call-1', 'search', 'x'.repeat(180), { summary: 'long result', truncated: false }),
      { id: 'user-2', role: 'user', createdAt: new Date().toISOString(), content: 'recent question' },
      { id: 'assistant-2', role: 'assistant', createdAt: new Date().toISOString(), content: 'recent answer' },
    ];

    const result = await manager.build({ sessionId: 's1', turnId: 't1', messages });
    const assistantMessage = result.requestMessages[2];
    const compactedToolMessage = result.requestMessages[3];

    expect(result.microCompactionApplied).toBe(true);
    expect(assistantMessage?.role).toBe('assistant');
    expect(compactedToolMessage?.role).toBe('tool');
    if (compactedToolMessage?.role !== 'tool') {
      throw new Error('Expected compacted tool message.');
    }

    expect(compactedToolMessage.content.text).toContain('Compact receipt');
  });

  it('injects one summary at the soft watermark and suppresses repeats until usage falls back', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    let summaryCalls = 0;
    const summaryProvider: SummaryProvider = {
      async summarize() {
        summaryCalls += 1;
        return 'summarized';
      },
    };
    const manager = new ContextManager(provider, observability, summaryProvider, { maxTokens: 100, liveWindowSegments: 1, softWatermark: 0.65, hysteresis: 0.2 });

    const messages: Message[] = [
      { id: 'sys-1', role: 'system', createdAt: new Date().toISOString(), content: 'system' },
      { id: 'user-1', role: 'user', createdAt: new Date().toISOString(), content: 'a'.repeat(80) },
      { id: 'assistant-1', role: 'assistant', createdAt: new Date().toISOString(), content: 'recent' },
    ];

    const first = await manager.build({ sessionId: 's2', turnId: 't1', messages, goal: 'test goal' });
    const second = await manager.build({ sessionId: 's2', turnId: 't2', messages, goal: 'test goal' });
    const third = await manager.build({
      sessionId: 's2',
      turnId: 't3',
      messages: [{ id: 'sys-1', role: 'system', createdAt: new Date().toISOString(), content: 'small' }],
    });
    await manager.build({ sessionId: 's2', turnId: 't4', messages, goal: 'test goal' });

    expect(first.summaryInjected).toBe(true);
    expect(second.summaryInjected).toBe(false);
    expect(third.summaryInjected).toBe(false);
    expect(summaryCalls).toBe(2);
  });

  it('injects a summary after receipt compaction when the compacted context still crosses the soft watermark', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    let summaryCalls = 0;
    const summaryProvider: SummaryProvider = {
      async summarize() {
        summaryCalls += 1;
        return 'older tool results summarized';
      },
    };
    const manager = new ContextManager(provider, observability, summaryProvider, {
      maxTokens: 500,
      softWatermark: 0.65,
      hysteresis: 0.1,
      liveWindowSegments: 2,
    });
    const messages: Message[] = [
      { id: 'sys-1', role: 'system', createdAt: new Date().toISOString(), content: 'system' },
    ];

    for (let index = 0; index < 10; index += 1) {
      const toolCallId = `call-summary-${index + 1}`;
      messages.push(createAssistantMessage({
        content: `tool call ${index + 1}`,
        toolCalls: [{ id: toolCallId, name: 'search', input: { q: `item-${index + 1}` } }],
        finishReason: 'tool_calls',
      }));
      messages.push(createToolResultMessage(toolCallId, 'search', 'x'.repeat(220), {
        summary: `result-${index + 1}`,
        truncated: false,
      }));
    }

    messages.push({ id: 'user-last', role: 'user', createdAt: new Date().toISOString(), content: 'latest question' });

    const result = await manager.build({
      sessionId: 's3',
      turnId: 't1',
      messages,
      goal: 'Summarize previous 10 tool results',
    });
    const summaryIndex = result.requestMessages.findIndex(
      (message) => message.role === 'system' && message.content.startsWith('Summary of earlier closed context:'),
    );

    expect(result.microCompactionApplied).toBe(true);
    expect(result.summaryInjected).toBe(true);
    expect(summaryCalls).toBe(1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(result.requestMessages[summaryIndex + 1]?.role).toBe('assistant');
    expect(result.requestMessages[summaryIndex + 2]?.role).toBe('tool');
  });

  it('skips summary after receipt compaction when the compacted context falls back below the soft watermark', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    let summaryCalls = 0;
    const summaryProvider: SummaryProvider = {
      async summarize() {
        summaryCalls += 1;
        return 'older tool results summarized';
      },
    };
    const manager = new ContextManager(provider, observability, summaryProvider, {
      maxTokens: 1_000,
      softWatermark: 0.65,
      hysteresis: 0.1,
      liveWindowSegments: 2,
    });
    const messages: Message[] = [
      { id: 'sys-1', role: 'system', createdAt: new Date().toISOString(), content: 'system' },
    ];

    for (let index = 0; index < 10; index += 1) {
      const toolCallId = `call-compact-${index + 1}`;
      messages.push(createAssistantMessage({
        content: `tool call ${index + 1}`,
        toolCalls: [{ id: toolCallId, name: 'search', input: { q: `item-${index + 1}` } }],
        finishReason: 'tool_calls',
      }));
      messages.push(createToolResultMessage(toolCallId, 'search', 'x'.repeat(220), {
        summary: `result-${index + 1}`,
        truncated: false,
      }));
    }

    messages.push({ id: 'user-last', role: 'user', createdAt: new Date().toISOString(), content: 'latest question' });

    const result = await manager.build({
      sessionId: 's4',
      turnId: 't1',
      messages,
      goal: 'Summarize previous 10 tool results',
    });

    expect(result.microCompactionApplied).toBe(true);
    expect(result.summaryInjected).toBe(false);
    expect(summaryCalls).toBe(0);
  });

  it('keeps artifact ids in tool messages that stay in the request context', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    const manager = new ContextManager(provider, observability);
    const messages: Message[] = [
      { id: 'user-1', role: 'user', createdAt: new Date().toISOString(), content: 'Search large file' },
      createAssistantMessage({
        content: 'searching',
        toolCalls: [{ id: 'call-artifact', name: 'search', input: { q: 'large file' } }],
        finishReason: 'tool_calls',
      }),
      createToolResultMessage('call-artifact', 'search', 'Output truncated.', {
        summary: 'large result',
        truncated: true,
        artifactId: 'artifact-123',
      }),
    ];

    const result = await manager.build({ sessionId: 's5', turnId: 't1', messages });
    const toolMessage = result.requestMessages[2];
    expect(toolMessage?.role).toBe('tool');
    if (toolMessage?.role !== 'tool') {
      throw new Error('Expected tool message.');
    }

    expect(toolMessage.content.artifactId).toBe('artifact-123');
  });

  it('injects policy guidance into the next request as a dedicated system message', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    const manager = new ContextManager(provider, observability);
    const messages: Message[] = [
      { id: 'user-ctx-1', role: 'user', createdAt: new Date().toISOString(), content: 'Update README.md' },
    ];

    const result = await manager.build({
      sessionId: 's6',
      turnId: 't1',
      messages,
      contextInjections: [
        {
          source: 'structured_tool_preference',
          content: 'Use read_file for bounded file reads before using bash cat.',
        },
        {
          source: 'structured_tool_preference',
          content: 'Use read_file for bounded file reads before using bash cat.',
        },
      ],
    });

    const guidanceMessage = result.requestMessages.find(
      (message) => message.role === 'system' && message.content.startsWith('Policy guidance:'),
    );

    expect(guidanceMessage).toBeDefined();
    expect(guidanceMessage?.content).toContain('structured_tool_preference');
    expect(guidanceMessage?.content).toContain('Use read_file for bounded file reads before using bash cat.');
    expect(observability.count('context.inject', 'executed')).toBe(1);
  });

  it('injects recalled memory into a dedicated head system message', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    const manager = new ContextManager(provider, observability);
    const messages: Message[] = [
      { id: 'user-memory-1', role: 'user', createdAt: new Date().toISOString(), content: 'How did we fix vite build?' },
    ];

    const result = await manager.build({
      sessionId: 's7',
      turnId: 't1',
      messages,
      contextInjections: [
        {
          source: 'memory.recall',
          content: 'Vite Build Fix: aligned tsconfig paths and cleaned stale output.',
        },
      ],
    });

    const memoryMessage = result.requestMessages.find(
      (message) => message.role === 'system' && message.content.startsWith('Memory recall:'),
    );

    expect(memoryMessage).toBeDefined();
    expect(memoryMessage?.content).toContain('Vite Build Fix');
    expect(observability.count('context.inject.memory', 'executed')).toBe(1);
  });
});