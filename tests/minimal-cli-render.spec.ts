import { describe, expect, it } from 'vitest';

import { formatPendingApproval, formatSessionSnapshot } from '../src/cli/render-output.js';
import { createMessageId, createTimestamp } from '../src/types/messages.js';
import type { AgentSession, PendingToolApproval, ToolMessage } from '../src/types/index.js';

function createToolMessage(overrides: Partial<ToolMessage> = {}): ToolMessage {
  return {
    id: createMessageId('tool'),
    role: 'tool',
    createdAt: createTimestamp(),
    toolCallId: 'call-1',
    toolName: 'bash',
    isError: true,
    content: {
      text: 'spawn node -e "console.log(1)" ENOENT',
      summary: 'command failed',
      truncated: false,
      metadata: {
        blocked: false,
        policyAction: 'allow',
        backendPath: 'default -> shell.command_line',
        matchedRules: [
          {
            policy: 'risk_scorer',
            rule: 'shell_syntax',
            message: 'RiskScorer marked the shell command as medium risk because it relies on shell syntax.',
          },
          {
            policy: 'structured_tool_preference',
            rule: 'prefer_read_file',
            message: 'Prefer read_file for workspace file reads instead of using bash cat/head/tail/sed.',
          },
        ],
      },
    },
    ...overrides,
  };
}

function createApproval(overrides: Partial<PendingToolApproval> = {}): PendingToolApproval {
  return {
    id: 'approval-1',
    toolCallId: 'call-1',
    toolName: 'write_file',
    input: { path: 'README.md', content: 'hello' },
    inputSummary: '{"path":"README.md"}',
    reason: 'file_write',
    risk: 'high',
    message: 'write_file requires explicit approval before modifying workspace files.',
    createdAt: createTimestamp(),
    ...overrides,
  };
}

function createSession(): AgentSession {
  return {
    id: 'cli-1',
    turnId: 'cli-1:turn:0',
    status: 'completed',
    messages: [
      {
        id: createMessageId('user'),
        role: 'user',
        createdAt: createTimestamp(),
        content: 'Read package.json and update README.md',
      },
      {
        id: createMessageId('assistant'),
        role: 'assistant',
        createdAt: createTimestamp(),
        content: 'I will inspect the project first.',
        toolCalls: [
          {
            id: 'call-list-dir',
            name: 'list_dir',
            input: { path: '.' },
          },
        ],
        finishReason: 'tool_calls',
      },
      createToolMessage(),
    ],
    pendingApprovals: [],
    pendingInterventions: [],
    pendingContextInjections: [],
    toolCallHistory: [],
    createdAt: createTimestamp(),
    updatedAt: createTimestamp(),
    isRunning: false,
    terminationReason: 'max_steps',
  };
}

describe('minimal CLI rendering', () => {
  it('formats session snapshots as readable text', () => {
    const rendered = formatSessionSnapshot(createSession());

    expect(rendered).toContain('Session: cli-1');
    expect(rendered).toContain('Status: completed');
    expect(rendered).toContain('Termination: max_steps');
    expect(rendered).toContain('Approval: not triggered in this session trace.');
    expect(rendered).toContain('The run stopped before any approval-gated tool call appeared in the message trace.');
    expect(rendered).toContain('Last message: tool bash [error]');
    expect(rendered).toContain('Policy action: allow');
    expect(rendered).toContain('Backend path: default -> shell.command_line');
    expect(rendered).toContain('Matched rules:');
    expect(rendered).toContain('structured_tool_preference/prefer_read_file');
    expect(rendered).toContain('Message trace:');
    expect(rendered).toContain('#1: user');
    expect(rendered).toContain('#2: assistant');
    expect(rendered).toContain('#3: tool bash [error]');
    expect(rendered).toContain('Output:');
    expect(rendered).toContain('spawn node -e "console.log(1)" ENOENT');
  });

  it('formats pending approvals as readable text', () => {
    const rendered = formatPendingApproval(createApproval(), 2);

    expect(rendered).toContain('Approval required (2 pending)');
    expect(rendered).toContain('Tool: write_file');
    expect(rendered).toContain('Reason: file_write');
    expect(rendered).toContain('Input summary:');
  });
});