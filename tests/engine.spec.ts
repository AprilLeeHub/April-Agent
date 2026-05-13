import { describe, expect, it } from 'vitest';

import { AgentEngine } from '../src/engine/agent-engine.js';
import { ContextManager } from '../src/engine/context-manager.js';
import { Observability } from '../src/engine/observability.js';
import { createAssistantMessage } from '../src/llm/provider.js';
import { SessionQueryService } from '../src/session/session-query.js';
import { MemoryCheckpointStore } from '../src/storage/checkpoint-store.js';
import { MemorySessionStore } from '../src/storage/session-store.js';
import { MemoryArtifactStore } from '../src/storage/artifact-store.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Message, ProviderAdapter, ProviderRequest, ProviderResponse } from '../src/types/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly capabilities = { supportsToolCalls: true, supportsThinking: false, contextWindow: 4_000 };
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No fake provider response queued.');
    }

    return response;
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((count, message) => count + (message.role === 'tool' ? message.content.text.length : message.content.length), 0);
  }
}

describe('AgentEngine', () => {
  it('runs a full tool-assisted loop and preserves assistant-tool adjacency', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'calling tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'hello' } }],
          finishReason: 'tool_calls',
        }),
      },
      {
        assistant: createAssistantMessage({
          content: 'done',
          finishReason: 'stop',
        }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echoes text',
      execute: async (input) => ({ echoed: (input as { text: string }).text }),
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

    await engine.createSession('engine-1');
    await engine.submitUserInput('engine-1', 'hello');
    await engine.confirmTurn('engine-1');
    const session = await engine.runTurn('engine-1');

    expect(session.status).toBe('completed');
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(provider.requests).toHaveLength(2);
  });

  it('queues interventions until the tool chain closes, then flushes them before the next model call', async () => {
    const toolGate = deferred<string>();
    const toolStarted = deferred<void>();
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'calling tool',
          toolCalls: [{ id: 'call-2', name: 'wait', input: {} }],
          finishReason: 'tool_calls',
        }),
      },
      {
        assistant: createAssistantMessage({ content: 'finished', finishReason: 'stop' }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    registry.register({
      name: 'wait',
      description: 'waits for a gate',
      async execute() {
        toolStarted.resolve();
        return toolGate.promise;
      },
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

    await engine.createSession('engine-2');
    await engine.submitUserInput('engine-2', 'wait for tool');
    await engine.confirmTurn('engine-2');

    const runPromise = engine.runTurn('engine-2');
    await toolStarted.promise;
    await engine.queueIntervention('engine-2', {
      id: 'intervention-1',
      role: 'user',
      createdAt: new Date().toISOString(),
      content: 'human intervention',
    });

    const midRun = await sessionStore.get('engine-2');
    expect(midRun?.pendingInterventions).toHaveLength(1);
    expect(midRun?.messages.some((message) => message.role === 'user' && message.content === 'human intervention')).toBe(false);

    toolGate.resolve('ok');
    const session = await runPromise;
    expect(session.pendingInterventions).toHaveLength(0);
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
  });

  it('cancels within the same turn while a tool is running', async () => {
    const toolStarted = deferred<void>();
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'calling tool',
          toolCalls: [{ id: 'call-3', name: 'cancel_me', input: {} }],
          finishReason: 'tool_calls',
        }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    registry.register({
      name: 'cancel_me',
      description: 'waits for abort',
      async execute(_input, context) {
        toolStarted.resolve();
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
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

    await engine.createSession('engine-3');
    await engine.submitUserInput('engine-3', 'cancel test');
    await engine.confirmTurn('engine-3');
    const runPromise = engine.runTurn('engine-3');

    await toolStarted.promise;
    await engine.cancel('engine-3');
    const session = await runPromise;

    expect(session.status).toBe('completed');
    expect(session.terminationReason).toBe('cancelled');
    expect(session.isRunning).toBe(false);
  });

  it('pauses the turn when a tool requires approval and exposes the pending approval in the session view', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'need approval',
          toolCalls: [{ id: 'call-approval-1', name: 'write_file', input: { path: 'a.txt', content: 'hello' } }],
          finishReason: 'tool_calls',
        }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    const sessionStore = new MemorySessionStore();
    let executed = false;

    registry.register({
      name: 'write_file',
      description: 'writes a file',
      requiresApproval: () => ({
        reason: 'file_write',
        risk: 'high',
        message: 'write_file requires explicit approval before writing.',
      }),
      execute: async () => {
        executed = true;
        return 'ok';
      },
    });

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

    await engine.createSession('engine-approval-1');
    await engine.submitUserInput('engine-approval-1', 'write a file');
    await engine.confirmTurn('engine-approval-1');
    const session = await engine.runTurn('engine-approval-1');
    const view = await new SessionQueryService(sessionStore).getView('engine-approval-1');

    expect(executed).toBe(false);
    expect(session.status).toBe('awaiting_approval');
    expect(session.isRunning).toBe(false);
    expect(session.pendingApprovals).toHaveLength(1);
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(provider.requests).toHaveLength(1);
    expect(view?.pendingApprovals).toHaveLength(1);
    expect(view?.lastMessages.at(-1)?.role).toBe('tool');
  });

  it('keeps tool-call adjacency intact when approval pauses a batch with multiple tool calls', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'need approval before batch can continue',
          toolCalls: [
            { id: 'call-approval-2', name: 'write_file', input: { path: 'a.txt', content: 'hello' } },
            { id: 'call-batch-2', name: 'echo', input: { text: 'after approval' } },
          ],
          finishReason: 'tool_calls',
        }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();

    registry.register({
      name: 'write_file',
      description: 'writes a file',
      requiresApproval: () => ({
        reason: 'file_write',
        risk: 'high',
        message: 'write_file requires explicit approval before writing.',
      }),
      execute: async () => 'ok',
    });
    registry.register({
      name: 'echo',
      description: 'echoes input',
      execute: async (input) => input,
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

    await engine.createSession('engine-approval-2');
    await engine.submitUserInput('engine-approval-2', 'write then echo');
    await engine.confirmTurn('engine-approval-2');
    const session = await engine.runTurn('engine-approval-2');

    expect(session.status).toBe('awaiting_approval');
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    const deferredMessage = session.messages.at(-1);
    expect(deferredMessage?.role).toBe('tool');
    if (deferredMessage?.role !== 'tool') {
      throw new Error('Expected deferred tool message.');
    }

    expect(deferredMessage.content.metadata).toMatchObject({ deferred: true, blocked: true });
  });

  it('approves a paused tool batch, executes the blocked and following tools, and completes the turn', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'need approval before batch can continue',
          toolCalls: [
            { id: 'call-approval-3', name: 'write_file', input: { path: 'a.txt', content: 'hello' } },
            { id: 'call-batch-3', name: 'echo', input: { text: 'after approval' } },
          ],
          finishReason: 'tool_calls',
        }),
      },
      {
        assistant: createAssistantMessage({ content: 'batch completed', finishReason: 'stop' }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    let writeExecutions = 0;
    let echoExecutions = 0;

    registry.register({
      name: 'write_file',
      description: 'writes a file',
      requiresApproval: () => ({
        reason: 'file_write',
        risk: 'high',
        message: 'write_file requires explicit approval before writing.',
      }),
      execute: async () => {
        writeExecutions += 1;
        return 'written';
      },
    });
    registry.register({
      name: 'echo',
      description: 'echoes input',
      execute: async (input) => {
        echoExecutions += 1;
        return (input as { text: string }).text;
      },
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

    await engine.createSession('engine-approval-3');
    await engine.submitUserInput('engine-approval-3', 'write then echo');
    await engine.confirmTurn('engine-approval-3');
    const pausedSession = await engine.runTurn('engine-approval-3');
    const approvalId = pausedSession.pendingApprovals[0]?.id;
    if (!approvalId) {
      throw new Error('Expected pending approval.');
    }

    const resumedSession = await engine.approvePendingToolCall('engine-approval-3', approvalId);

    expect(resumedSession.status).toBe('completed');
    expect(resumedSession.pendingApprovals).toHaveLength(0);
    expect(resumedSession.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(writeExecutions).toBe(1);
    expect(echoExecutions).toBe(1);
    expect(provider.requests).toHaveLength(2);

    const writeResult = resumedSession.messages[2];
    const echoResult = resumedSession.messages[3];
    if (writeResult?.role !== 'tool' || echoResult?.role !== 'tool') {
      throw new Error('Expected resumed tool results.');
    }

    expect(writeResult.content.text).toContain('written');
    expect(writeResult.content.metadata?.blocked).not.toBe(true);
    expect(echoResult.content.text).toContain('after approval');
    expect(echoResult.content.metadata?.deferred).not.toBe(true);
  });

  it('denies a pending tool call, records a denial tool result, and resumes reasoning', async () => {
    const provider = new FakeProvider([
      {
        assistant: createAssistantMessage({
          content: 'need approval',
          toolCalls: [{ id: 'call-approval-4', name: 'write_file', input: { path: 'a.txt', content: 'hello' } }],
          finishReason: 'tool_calls',
        }),
      },
      {
        assistant: createAssistantMessage({ content: 'skip write', finishReason: 'stop' }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    let executed = false;

    registry.register({
      name: 'write_file',
      description: 'writes a file',
      requiresApproval: () => ({
        reason: 'file_write',
        risk: 'high',
        message: 'write_file requires explicit approval before writing.',
      }),
      execute: async () => {
        executed = true;
        return 'written';
      },
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

    await engine.createSession('engine-approval-4');
    await engine.submitUserInput('engine-approval-4', 'write a file');
    await engine.confirmTurn('engine-approval-4');
    const pausedSession = await engine.runTurn('engine-approval-4');
    const approvalId = pausedSession.pendingApprovals[0]?.id;
    if (!approvalId) {
      throw new Error('Expected pending approval.');
    }

    const resumedSession = await engine.denyPendingToolCall('engine-approval-4', approvalId, '人工拒绝。');

    expect(executed).toBe(false);
    expect(resumedSession.status).toBe('completed');
    expect(resumedSession.pendingApprovals).toHaveLength(0);
    expect(resumedSession.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(provider.requests).toHaveLength(2);

    const deniedMessage = resumedSession.messages[2];
    if (deniedMessage?.role !== 'tool') {
      throw new Error('Expected denial tool result.');
    }

    expect(deniedMessage.content.text).toContain('工具执行已被拒绝');
    expect(deniedMessage.content.metadata).toMatchObject({ approvalDenied: true, blocked: true });
  });

  it('blocks the sixth identical tool call and lets the model respond to the loop guard interruption', async () => {
    const provider = new FakeProvider([
      ...Array.from({ length: 6 }, (_, index) => ({
        assistant: createAssistantMessage({
          content: `echo ${index + 1}`,
          toolCalls: [{ id: `call-loop-${index + 1}`, name: 'echo', input: { text: 'repeat' } }],
          finishReason: 'tool_calls',
        }),
      })),
      {
        assistant: createAssistantMessage({
          content: 'Loop guard triggered',
          finishReason: 'stop',
        }),
      },
    ]);
    const observability = new Observability();
    const registry = new ToolRegistry();
    let executions = 0;

    registry.register({
      name: 'echo',
      description: 'echoes text',
      execute: async (input) => {
        executions += 1;
        return (input as { text: string }).text;
      },
    });

    const engine = new AgentEngine(
      provider,
      registry,
      new ToolExecutor(registry, new MemoryArtifactStore(), observability),
      new MemorySessionStore(),
      new MemoryCheckpointStore(),
      new ContextManager(provider, observability),
      observability,
      { model: 'fake-model', maxSteps: 8 },
    );

    await engine.createSession('engine-loop-1');
    await engine.submitUserInput('engine-loop-1', 'Run echo 1 to echo 6');
    await engine.confirmTurn('engine-loop-1');
    const session = await engine.runTurn('engine-loop-1');
    const blockedMessage = session.messages.filter((message) => message.role === 'tool').at(-1);

    expect(session.status).toBe('completed');
    expect(executions).toBe(5);
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Loop guard triggered' });
    expect(blockedMessage?.role).toBe('tool');
    if (blockedMessage?.role !== 'tool') {
      throw new Error('Expected blocked tool message.');
    }

    expect(blockedMessage.content.metadata).toMatchObject({ blocked: true });
    expect(blockedMessage.content.text).toContain('Loop guard blocked');
  });
});