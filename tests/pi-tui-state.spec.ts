import { describe, expect, it } from 'vitest';

import {
  buildPiTuiSidebarSnapshot,
  buildSidebarMarkdown,
  formatApprovalForPiTui,
  formatMessageForPiTui,
} from '../src/cli/pi-tui-state.js';
import { createSession } from '../src/types/index.js';

describe('pi-tui state helpers', () => {
  it('formats assistant tool calls into markdown bullets', () => {
    const formatted = formatMessageForPiTui({
      id: 'assistant-1',
      role: 'assistant',
      createdAt: new Date().toISOString(),
      content: 'I will inspect the workspace.',
      toolCalls: [
        { id: 'call-1', name: 'read_file', input: { path: 'package.json' } },
        { id: 'call-2', name: 'grep_search', input: { query: 'createRuntime' } },
      ],
    });

    expect(formatted.kind).toBe('assistant');
    expect(formatted.markdown).toContain('## Tool Calls');
    expect(formatted.markdown).toContain('- read_file');
    expect(formatted.markdown).toContain('- grep_search');
  });

  it('formats approval details for the overlay body', () => {
    const markdown = formatApprovalForPiTui({
      id: 'approval-1',
      toolCallId: 'call-1',
      toolName: 'write_file',
      input: { path: 'tmp/demo.txt', content: 'hello' },
      inputSummary: 'write tmp/demo.txt with hello',
      reason: 'file_write',
      risk: 'high',
      message: 'write_file requires approval',
      createdAt: new Date().toISOString(),
    });

    expect(markdown).toContain('# Approval Required');
    expect(markdown).toContain('**Tool:** write_file');
    expect(markdown).toContain('```text');
    expect(markdown).toContain('write tmp/demo.txt with hello');
  });

  it('builds sidebar state from session and observability events', () => {
    const session = createSession('sidebar-session');
    session.status = 'awaiting_approval';
    session.latestUserGoal = 'Fix vite build';
    session.messages = [
      { id: 'user-1', role: 'user', createdAt: new Date().toISOString(), content: 'Fix vite build' },
    ];
    session.pendingApprovals = [
      {
        id: 'approval-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        input: { path: 'tmp/demo.txt' },
        inputSummary: 'write tmp/demo.txt',
        reason: 'file_write',
        risk: 'high',
        message: 'needs approval',
        createdAt: new Date().toISOString(),
      },
    ];

    const snapshot = buildPiTuiSidebarSnapshot({
      session,
      model: 'deepseek-chat',
      memoryEnabled: true,
      busy: true,
      events: [
        {
          id: 'decision-1',
          sessionId: session.id,
          turnId: session.turnId,
          decision: 'memory.recall',
          state: 'executed',
          message: 'Recalled 2 memory snippet(s) for the upcoming turn.',
          timestamp: new Date().toISOString(),
          metadata: { count: 2 },
        },
        {
          id: 'decision-2',
          sessionId: session.id,
          turnId: session.turnId,
          decision: 'tool.execute',
          state: 'executed',
          message: 'Executing write_file.',
          timestamp: new Date().toISOString(),
          metadata: { toolName: 'write_file' },
        },
      ],
    });

    expect(snapshot.memoryHits).toBe(2);
    expect(snapshot.pendingApprovals).toBe(1);
    expect(snapshot.lastToolName).toBe('write_file');
    expect(snapshot.busy).toBe(true);

    const markdown = buildSidebarMarkdown(snapshot);
    expect(markdown.overview).toContain('**Model:** deepseek-chat');
    expect(markdown.overview).toContain('**Recall hits:** 2');
    expect(markdown.recentEvents).toContain('`tool.execute`');
  });
});