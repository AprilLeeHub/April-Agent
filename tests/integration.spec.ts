import { describe, expect, it } from 'vitest';

import { AgentEngine } from '../src/engine/agent-engine.js';
import { ContextManager } from '../src/engine/context-manager.js';
import { Observability } from '../src/engine/observability.js';
import { createAssistantMessage } from '../src/llm/provider.js';
import { SessionQueryService } from '../src/session/session-query.js';
import { MemoryArtifactStore } from '../src/storage/artifact-store.js';
import { MemoryCheckpointStore } from '../src/storage/checkpoint-store.js';
import { MemorySessionStore } from '../src/storage/session-store.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Message, ProviderAdapter, ProviderRequest, ProviderResponse } from '../src/types/index.js';

class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly capabilities = { supportsToolCalls: true, supportsThinking: false, contextWindow: 4_000 };
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly responses: ProviderResponse[] = [
      {
        assistant: createAssistantMessage({
          content: 'first use the tool',
          toolCalls: [{ id: 'call-int-1', name: 'lookup', input: { key: 'x' } }],
          finishReason: 'tool_calls',
        }),
        usage: {
          inputTokens: 17,
          outputTokens: 5,
        },
      },
      {
        assistant: createAssistantMessage({ content: 'final answer', finishReason: 'stop' }),
        usage: {
          inputTokens: 22,
          outputTokens: 8,
        },
      },
    ],
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response queued.');
    }

    return response;
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((count, message) => count + (message.role === 'tool' ? message.content.text.length : message.content.length), 0);
  }
}

describe('integration', () => {
  it('runs a fake provider and fake tool end to end', async () => {
    const provider = new FakeProvider();
    const observability = new Observability();
    const registry = new ToolRegistry();
    registry.register({
      name: 'lookup',
      description: 'returns a fake lookup',
      execute: async () => ({ value: '42' }),
    });
    const sessionStore = new MemorySessionStore();

    const engine = new AgentEngine(
      provider,
      registry,
      new ToolExecutor(registry, new MemoryArtifactStore(), observability),
      sessionStore,
      new MemoryCheckpointStore(),
      new ContextManager(provider, observability),
      observability,
      { model: 'fake-model', maxSteps: 4 },
    );

    await engine.createSession('integration-1');
    await engine.submitUserInput('integration-1', 'what is x');
    await engine.confirmTurn('integration-1');
    const session = await engine.runTurn('integration-1');

    const query = new SessionQueryService(sessionStore);
    const view = await query.getView('integration-1');
    const tokenEvents = observability.list('integration-1').filter((event) => event.decision === 'llm.response');
    expect(session.status).toBe('completed');
    expect(view?.isRunning).toBe(false);
    expect(view?.lastMessages.at(-1)?.role).toBe('assistant');
    expect(tokenEvents).toHaveLength(2);
    expect(tokenEvents[0]?.metadata).toMatchObject({ inputTokens: 17, outputTokens: 5 });
  });

  it('injects tool-derived policy guidance into the next provider request', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'read the file first',
          toolCalls: [{ id: 'call-int-bash-1', name: 'bash', input: { command: 'cat', args: ['README.md'] } }],
          finishReason: 'tool_calls',
        }),
      },
      {
        assistant: createAssistantMessage({ content: 'done', finishReason: 'stop' }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    registry.register({
      name: 'bash',
      description: 'reads a file',
      execute: async () => ({ executionPath: 'shell.argv', stdout: 'README body', stderr: '' }),
    });

    const engine = new AgentEngine(
      provider,
      registry,
      new ToolExecutor(registry, new MemoryArtifactStore(), observability),
      new MemorySessionStore(),
      new MemoryCheckpointStore(),
      new ContextManager(provider, observability),
      observability,
      { model: 'fake-model', maxSteps: 4 },
    );

    await engine.createSession('integration-ctx-1');
    await engine.submitUserInput('integration-ctx-1', 'Update README.md');
    await engine.confirmTurn('integration-ctx-1');
    await engine.runTurn('integration-ctx-1');

    const secondRequest = provider.requests[1];
    const guidanceMessage = secondRequest?.messages.find(
      (message) => message.role === 'system' && message.content.startsWith('Policy guidance:'),
    );

    expect(guidanceMessage).toBeDefined();
    expect(guidanceMessage?.content).toContain('Use read_file with path and optional line range instead of shell-based file inspection.');
  });
});