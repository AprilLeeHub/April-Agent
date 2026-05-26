/**
 * Summary: Pure formatting and state-derivation helpers for the pi-tui CLI so
 * the interactive view can stay thin and the key logic remains testable.
 */

import type { AgentSession, DecisionEvent, Message, PendingToolApproval } from '../types/index.js';

export type PiTuiMessageKind = 'user' | 'assistant' | 'tool' | 'system';

export interface PiTuiFormattedMessage {
  kind: PiTuiMessageKind;
  title: string;
  markdown: string;
}

export interface PiTuiSidebarSnapshot {
  sessionId: string;
  turnId: string;
  model: string;
  status: string;
  busy: boolean;
  pendingApprovals: number;
  messageCount: number;
  memoryEnabled: boolean;
  memoryHits: number;
  latestUserGoal?: string;
  lastToolName?: string;
  lastToolState?: string;
  lastToolMessage?: string;
  lastMemoryExtract?: string;
  recentEvents: DecisionEvent[];
}

function compactText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function formatMessageForPiTui(message: Message): PiTuiFormattedMessage {
  if (message.role === 'user') {
    return {
      kind: 'user',
      title: 'User',
      markdown: message.content,
    };
  }

  if (message.role === 'assistant') {
    const toolCallLines = message.toolCalls?.length
      ? [
        '',
        '## Tool Calls',
        ...message.toolCalls.map((toolCall) => `- ${toolCall.name}`),
      ]
      : [];

    return {
      kind: 'assistant',
      title: 'Assistant',
      markdown: [message.content || 'Requested tool execution.', ...toolCallLines].join('\n').trim(),
    };
  }

  if (message.role === 'tool') {
    const detailBlock = message.content.text && message.content.text !== message.content.summary
      ? ['', '```text', compactText(message.content.text, 320), '```']
      : [];

    return {
      kind: 'tool',
      title: `Tool · ${message.toolName}${message.isError ? ' · Error' : ''}`,
      markdown: [
        `- **Status:** ${message.isError ? 'error' : 'ok'}`,
        `- **Summary:** ${message.content.summary || compactText(message.content.text)}`,
        ...(message.content.artifactId ? [`- **Artifact:** ${message.content.artifactId}`] : []),
        ...detailBlock,
      ].join('\n'),
    };
  }

  return {
    kind: 'system',
    title: 'System',
    markdown: message.content,
  };
}

export function formatApprovalForPiTui(approval: PendingToolApproval): string {
  return [
    '# Approval Required',
    '',
    `- **Tool:** ${approval.toolName}`,
    `- **Risk:** ${approval.risk}`,
    `- **Reason:** ${approval.reason}`,
    `- **Message:** ${approval.message}`,
    '',
    '## Input Summary',
    '',
    '```text',
    approval.inputSummary,
    '```',
    '',
    'Use the selector below to approve or deny this tool call.',
  ].join('\n');
}

export function buildPiTuiSidebarSnapshot(input: {
  session?: AgentSession;
  model: string;
  memoryEnabled: boolean;
  busy: boolean;
  events: DecisionEvent[];
}): PiTuiSidebarSnapshot {
  const { session, events } = input;
  const lastMemoryRecall = [...events].reverse().find((event) => event.decision === 'memory.recall');
  const lastMemoryRecallMetadata = asRecord(lastMemoryRecall?.metadata);
  const lastMemoryExtract = [...events].reverse().find((event) => event.decision === 'memory.extract');
  const lastToolEvent = [...events].reverse().find((event) => {
    const metadata = asRecord(event.metadata);
    return typeof metadata?.toolName === 'string';
  });
  const lastToolMetadata = asRecord(lastToolEvent?.metadata);
  const lastToolName = readString(lastToolMetadata?.toolName);

  return {
    sessionId: session?.id ?? 'not-started',
    turnId: session?.turnId ?? 'not-started',
    model: input.model,
    status: session?.status ?? 'awaiting_input',
    busy: input.busy,
    pendingApprovals: session?.pendingApprovals.length ?? 0,
    messageCount: session?.messages.length ?? 0,
    memoryEnabled: input.memoryEnabled,
    memoryHits: readNumber(lastMemoryRecallMetadata?.count) ?? 0,
    ...(session?.latestUserGoal ? { latestUserGoal: compactText(session.latestUserGoal, 120) } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(lastToolEvent ? { lastToolState: `${lastToolEvent.state} · ${lastToolEvent.decision}` } : {}),
    ...(lastToolEvent ? { lastToolMessage: compactText(lastToolEvent.message, 140) } : {}),
    ...(lastMemoryExtract ? { lastMemoryExtract: compactText(lastMemoryExtract.message, 140) } : {}),
    recentEvents: events.slice(-5),
  };
}

export function buildSidebarMarkdown(snapshot: PiTuiSidebarSnapshot): {
  overview: string;
  recentEvents: string;
} {
  const overviewLines = [
    '# Runtime',
    '',
    `- **Session:** ${snapshot.sessionId}`,
    `- **Turn:** ${snapshot.turnId}`,
    `- **Model:** ${snapshot.model}`,
    `- **Status:** ${snapshot.status}`,
    `- **Busy:** ${snapshot.busy ? 'yes' : 'no'}`,
    `- **Messages:** ${snapshot.messageCount}`,
    `- **Pending approvals:** ${snapshot.pendingApprovals}`,
    '',
    '# Memory',
    '',
    `- **Enabled:** ${snapshot.memoryEnabled ? 'yes' : 'no'}`,
    `- **Recall hits:** ${snapshot.memoryHits}`,
    ...(snapshot.lastMemoryExtract ? [`- **Last extract:** ${snapshot.lastMemoryExtract}`] : []),
    ...(snapshot.latestUserGoal ? [`- **Goal:** ${snapshot.latestUserGoal}`] : []),
    '',
    '# Tooling',
    '',
    `- **Last tool:** ${snapshot.lastToolName ?? 'n/a'}`,
    `- **Tool state:** ${snapshot.lastToolState ?? 'n/a'}`,
    ...(snapshot.lastToolMessage ? [`- **Tool detail:** ${snapshot.lastToolMessage}`] : []),
  ];

  const eventLines = snapshot.recentEvents.length > 0
    ? snapshot.recentEvents.map((event) => `- \`${event.state}\` \`${event.decision}\` ${compactText(event.message, 120)}`)
    : ['- No events yet.'];

  return {
    overview: overviewLines.join('\n'),
    recentEvents: ['# Recent Events', '', ...eventLines].join('\n'),
  };
}