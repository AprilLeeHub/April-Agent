import { describe, expect, it } from 'vitest';

import { Observability } from '../src/engine/observability.js';
import { MemoryArtifactStore } from '../src/storage/artifact-store.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createSession } from '../src/types/index.js';

describe('ToolRegistry', () => {
  it('rebuilds tool snapshots on each read so new tools appear next turn', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'first',
      description: 'first tool',
      execute: async () => 'ok',
    });

    const firstSnapshot = registry.snapshot().map((tool) => tool.name);
    registry.register({
      name: 'second',
      description: 'second tool',
      execute: async () => 'ok',
    });

    const secondSnapshot = registry.snapshot().map((tool) => tool.name);
    expect(firstSnapshot).toEqual(['first']);
    expect(secondSnapshot).toEqual(['first', 'second']);
  });
});

describe('ToolExecutor', () => {
  it('stores oversized tool output in the artifact store instead of echoing the full body', async () => {
    const registry = new ToolRegistry();
    const artifacts = new MemoryArtifactStore();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, artifacts, observability);
    const session = createSession('tools-1');

    registry.register({
      name: 'read_file',
      description: 'returns a huge string',
      outputKind: 'read-file',
      execute: async () => 'x'.repeat(20_100),
    });

    const result = await executor.execute(
      { id: 'call-1', name: 'read_file', input: {} },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.toolMessage.content.truncated).toBe(true);
    expect(result.toolMessage.content.artifactId).toBeTruthy();
    expect(result.toolMessage.content.text.length).toBeLessThan(20_100);

    const artifact = await artifacts.get(result.toolMessage.content.artifactId!);
    expect(artifact?.content.length).toBe(20_100);
  });

  it('blocks approval-gated tools and records the pending approval on the session', async () => {
    const registry = new ToolRegistry();
    const artifacts = new MemoryArtifactStore();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, artifacts, observability);
    const session = createSession('tools-approval-1');
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

    const result = await executor.execute(
      { id: 'call-approval-1', name: 'write_file', input: { path: 'a.txt', content: 'hello' } },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(executed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.pendingApproval?.toolName).toBe('write_file');
    expect(result.toolMessage.content.metadata).toMatchObject({
      approvalRequired: true,
      approvalReason: 'file_write',
      approvalRisk: 'high',
    });
    expect(session.pendingApprovals).toHaveLength(1);
    expect(observability.count('tool.approval', 'blocked')).toBe(1);
    expect(observability.count('policy.approval', 'blocked')).toBe(1);
  });

  it('does not block a different-input call now that the loop guard hashes the tool input', async () => {
    const registry = new ToolRegistry();
    const artifacts = new MemoryArtifactStore();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, artifacts, observability);
    const session = createSession('tools-2');
    const now = new Date().toISOString();

    registry.register({
      name: 'looped',
      description: 'should run for a different input',
      execute: async () => 'ok',
    });

    const signature = (executor as unknown as { signature: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => string }).signature({
      id: 'call-2',
      name: 'looped',
      input: { q: 1 },
    });

    session.toolCallHistory = [
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
    ];

    const result = await executor.execute(
      { id: 'call-2', name: 'looped', input: { q: 6 } },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.error).toBeUndefined();
    expect(observability.count('policy.loop_guard', 'blocked')).toBe(0);
  });

  it('blocks the sixth identical call using the last five-call loop guard window', async () => {
    const registry = new ToolRegistry();
    const artifacts = new MemoryArtifactStore();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, artifacts, observability);
    const session = createSession('tools-2b');
    const now = new Date().toISOString();

    registry.register({
      name: 'looped',
      description: 'should be blocked',
      execute: async () => {
        throw new Error('should not run');
      },
    });

    const signature = (executor as unknown as { signature: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => string }).signature({
      id: 'call-2b',
      name: 'looped',
      input: { q: 1 },
    });

    session.toolCallHistory = [
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
      { signature, seenAt: now },
    ];

    const result = await executor.execute(
      { id: 'call-2b', name: 'looped', input: { q: 1 } },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(true);
    expect(result.error).toContain('Loop guard blocked');
    expect(observability.count('loop.guard', 'blocked')).toBe(1);
    expect(observability.count('policy.loop_guard', 'blocked')).toBe(1);
  });

  it('skips approval when the caller explicitly resumes an already-approved tool call', async () => {
    const registry = new ToolRegistry();
    const artifacts = new MemoryArtifactStore();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, artifacts, observability);
    const session = createSession('tools-approval-2');
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

    const result = await executor.execute(
      { id: 'call-approval-2', name: 'write_file', input: { path: 'a.txt', content: 'hello' } },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
      { skipApproval: true },
    );

    expect(executed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.pendingApproval).toBeUndefined();
    expect(session.pendingApprovals).toHaveLength(0);
  });
});