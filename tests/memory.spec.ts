import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalMarkdownStore } from '../src/knowledge/local-markdown-store.js';
import { MemoryOrchestrator } from '../src/knowledge/orchestrator.js';
import { Observability } from '../src/engine/observability.js';
import { MemoryArtifactStore } from '../src/storage/artifact-store.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createMemoryFacadeTools } from '../src/tools/builtin/memory-facade-tools.js';
import { createSession } from '../src/types/index.js';
import type { SummaryProvider } from '../src/types/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('memory foundation', () => {
  it('saves and searches Markdown-backed memory entries', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-memory-'));
    tempDirs.push(rootDir);
    const store = new LocalMarkdownStore({ rootDir });
    const now = new Date().toISOString();

    const saved = await store.save({
      id: 'vite-fix',
      title: 'Vite Build Fix',
      content: 'We fixed the vite build by aligning tsconfig paths and cleaning stale output.',
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      metadata: {
        tags: ['vite', 'build'],
      },
    });

    expect(saved.path).toBe('.april-agent/memory/notes/vite-fix.md');

    const results = await store.search({ query: 'vite build', limit: 5 });
    expect(results[0]).toMatchObject({
      id: 'vite-fix',
      title: 'Vite Build Fix',
    });

    expect(await store.delete('vite-fix')).toBe(true);
    expect(await store.search({ query: 'vite build', limit: 5 })).toEqual([]);
  });

  it('keeps memory facade tools approval-free while still persisting entries', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-memory-tools-'));
    tempDirs.push(rootDir);
    const orchestrator = new MemoryOrchestrator({
      store: new LocalMarkdownStore({ rootDir }),
    });
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryFacadeTools({ orchestrator }));

    const executor = new ToolExecutor(registry, new MemoryArtifactStore(), new Observability());
    const session = createSession('memory-tools-session');
    const result = await executor.execute(
      {
        id: 'call-memory-save-1',
        name: 'save_to_memory',
        input: {
          id: 'project-status',
          title: 'Project Status',
          content: 'Current status: memory facade tools should auto-run without approval.',
        },
      },
      session,
      { sessionId: session.id, turnId: session.turnId, signal: new AbortController().signal },
    );

    expect(result.blocked).toBe(false);
    expect(result.pendingApproval).toBeUndefined();
    expect(session.pendingApprovals).toHaveLength(0);

    const searchResult = await orchestrator.search({ query: 'auto-run approval', limit: 5 });
    expect(searchResult[0]).toMatchObject({
      id: 'project-status',
      title: 'Project Status',
    });
  });

  it('extracts an episodic memory with configurable metadata', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-memory-extract-'));
    tempDirs.push(rootDir);
    const summaryProvider: SummaryProvider = {
      async summarize() {
        return '- User intent: fix vite build\n- Tool read_file: inspected tsconfig\n- Outcome: build recovered';
      },
    };
    const orchestrator = new MemoryOrchestrator({
      store: new LocalMarkdownStore({ rootDir }),
      summaryProvider,
      metadata: {
        defaults: {
          scope: 'episode',
        },
        resolve: ({ checkpoint }) => ({
          checkpointStage: checkpoint.stage,
        }),
      },
    });
    const session = createSession('memory-extract-session');
    const now = new Date().toISOString();
    session.latestUserGoal = 'Fix vite build';
    session.messages = [
      { id: 'user-1', role: 'user', createdAt: now, content: 'Fix vite build after the tsconfig change.' },
      { id: 'assistant-1', role: 'assistant', createdAt: now, content: 'I will inspect the config.' },
      {
        id: 'tool-1',
        role: 'tool',
        createdAt: now,
        toolCallId: 'call-1',
        toolName: 'read_file',
        isError: false,
        content: {
          text: 'compilerOptions paths look stale',
          summary: 'inspected tsconfig and found stale paths',
          truncated: false,
        },
      },
    ];

    const extracted = await orchestrator.extractTurn({
      session,
      checkpoint: {
        sessionId: session.id,
        turnId: session.turnId,
        stage: 'turn_end',
        session,
        createdAt: now,
        decisionEvents: [
          {
            id: 'decision-1',
            sessionId: session.id,
            turnId: session.turnId,
            decision: 'memory.extract',
            state: 'executed',
            message: 'Prepared episodic summary.',
            timestamp: now,
          },
        ],
      },
    });

    expect(extracted).toBeDefined();
    expect(extracted?.metadata).toMatchObject({
      kind: 'episode',
      scope: 'episode',
      checkpointStage: 'turn_end',
      turnId: session.turnId,
    });

    const results = await orchestrator.search({ query: session.turnId, limit: 5 });
    expect(results.some((result) => result.title.includes(session.turnId))).toBe(true);
  });
});