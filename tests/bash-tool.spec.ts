import { describe, expect, it } from 'vitest';

import { Observability } from '../src/engine/observability.js';
import { MemoryArtifactStore } from '../src/storage/artifact-store.js';
import { createBashTool } from '../src/tools/builtin/bash-tool.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createSession } from '../src/types/index.js';

describe('bash tool', () => {
  it('runs a low-risk command through the shell executor', async () => {
    const registry = new ToolRegistry();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), observability);
    const session = createSession('bash-1');

    registry.register(createBashTool({ rootDir: process.cwd() }));
    const result = await executor.execute(
      {
        id: 'call-bash-1',
        name: 'bash',
        input: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("hello")'],
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.toolMessage.content.text).toContain('hello');
  });

  it('accepts a full command line string when args are omitted', async () => {
    const registry = new ToolRegistry();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), observability);
    const session = createSession('bash-raw-command');

    registry.register(createBashTool({ rootDir: process.cwd() }));
    const result = await executor.execute(
      {
        id: 'call-bash-raw-command',
        name: 'bash',
        input: {
          command: `${process.execPath} -e "process.stdout.write('hello from raw command')"`,
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.toolMessage.content.text).toContain('hello from raw command');
  });

  it('executes shell syntax when the raw command line contains pipes or redirects', async () => {
    const registry = new ToolRegistry();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), observability);
    const session = createSession('bash-shell-syntax');

    registry.register(createBashTool({ rootDir: process.cwd() }));
    const result = await executor.execute(
      {
        id: 'call-bash-shell-syntax',
        name: 'bash',
        input: {
          command: 'printf "alpha\\nbeta\\n" | head -n 1 >/dev/null; printf "done"',
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.toolMessage.content.text).toContain('done');
  });

  it('blocks risky shell command lines before execution', async () => {
    const registry = new ToolRegistry();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), observability);
    const session = createSession('bash-shell-risky');

    registry.register(createBashTool({ rootDir: process.cwd() }));
    const result = await executor.execute(
      {
        id: 'call-bash-shell-risky',
        name: 'bash',
        input: {
          command: 'printf "ok"; curl https://example.com',
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(true);
    expect(result.pendingApproval?.reason).toBe('shell_network');
  });

  it('routes network-capable commands through approval instead of execution', async () => {
    const registry = new ToolRegistry();
    const observability = new Observability();
    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), observability);
    const session = createSession('bash-2');

    registry.register(createBashTool({ rootDir: process.cwd() }));
    const result = await executor.execute(
      {
        id: 'call-bash-2',
        name: 'bash',
        input: {
          command: 'curl',
          args: ['https://example.com'],
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(true);
    expect(result.pendingApproval?.reason).toBe('shell_network');
    expect(session.pendingApprovals).toHaveLength(1);
    expect(observability.count('tool.approval', 'blocked')).toBe(1);
  });
});