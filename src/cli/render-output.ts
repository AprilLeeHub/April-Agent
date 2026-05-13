/**
 * Summary: Human-readable rendering helpers for the minimal runtime CLI.
 */

import type { AgentSession, Message, PendingToolApproval, ToolCall } from '../types/index.js';

type JsonLikeRecord = Record<string, unknown>;

function indentBlock(value: string, prefix = '  '): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function asRecord(value: unknown): JsonLikeRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonLikeRecord;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toRecordArray(value: unknown): JsonLikeRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonLikeRecord => entry !== undefined);
}

function formatMetadataSummary(metadata: unknown): string[] {
  const record = asRecord(metadata);
  if (!record) {
    return [];
  }

  const lines: string[] = [];
  const policyAction = readString(record.policyAction);
  const backendPath = readString(record.backendPath);
  const riskLevel = readString(record.riskLevel);
  const riskReason = readString(record.riskReason);
  const matchedRules = toRecordArray(record.matchedRules);
  const contextInjections = toRecordArray(record.contextInjections);

  if (policyAction) {
    lines.push(`Policy action: ${policyAction}`);
  }

  if (backendPath) {
    lines.push(`Backend path: ${backendPath}`);
  }

  if (riskLevel) {
    lines.push(`Risk: ${riskLevel}${riskReason ? ` (${riskReason})` : ''}`);
  }

  if (matchedRules.length > 0) {
    lines.push('Matched rules:');
    lines.push(...matchedRules.map((rule, index) => {
      const policy = readString(rule.policy) ?? 'unknown_policy';
      const name = readString(rule.rule) ?? 'unknown_rule';
      const message = readString(rule.message);
      return `${index + 1}. ${policy}/${name}${message ? ` - ${message}` : ''}`;
    }));
  }

  if (contextInjections.length > 0) {
    lines.push('Context injections:');
    lines.push(...contextInjections.map((injection, index) => {
      const source = readString(injection.source) ?? 'unknown';
      const content = readString(injection.content) ?? '';
      return `${index + 1}. ${source}${content ? ` - ${content}` : ''}`;
    }));
  }

  return lines;
}

function formatToolCalls(toolCalls: ToolCall[]): string[] {
  if (toolCalls.length === 0) {
    return [];
  }

  return [
    'Tool calls:',
    ...toolCalls.map((toolCall, index) => `${index + 1}. ${toolCall.name} ${stringifyJson(toolCall.input)}`),
  ];
}

function formatMessage(message: Message | undefined, heading = 'Last message'): string[] {
  if (!message) {
    return [`${heading}: <none>`];
  }

  if (message.role === 'tool') {
    const lines = [`${heading}: tool ${message.toolName}${message.isError ? ' [error]' : ' [ok]'}`];

    if (message.content.summary && message.content.summary !== message.content.text) {
      lines.push(`Summary: ${message.content.summary}`);
    }

    lines.push(...formatMetadataSummary(message.content.metadata));

    if (message.content.metadata && Object.keys(message.content.metadata).length > 0) {
      lines.push('Metadata:');
      lines.push(indentBlock(stringifyJson(message.content.metadata)));
    }

    lines.push('Output:');
    lines.push(indentBlock(message.content.text || '<empty>'));
    return lines;
  }

  if (message.role === 'assistant') {
    const lines = [`${heading}: assistant`];

    if (message.finishReason) {
      lines.push(`Finish reason: ${message.finishReason}`);
    }

    if (message.content) {
      lines.push('Content:');
      lines.push(indentBlock(message.content));
    }

    lines.push(...formatToolCalls(message.toolCalls ?? []));
    return lines;
  }

  return [
    `${heading}: ${message.role}`,
    'Content:',
    indentBlock(message.content),
  ];
}

function hasApprovalTrace(message: Message): boolean {
  if (message.role !== 'tool') {
    return false;
  }

  const metadata = asRecord(message.content.metadata);
  if (!metadata) {
    return false;
  }

  return metadata.approvalRequired === true || metadata.approvalDenied === true || typeof metadata.approvalId === 'string';
}

function formatApprovalSummary(session: AgentSession): string[] {
  if (session.pendingApprovals.length > 0) {
    return [`Approval: awaiting ${session.pendingApprovals.length} decision(s).`];
  }

  const approvalMessages = session.messages.filter(hasApprovalTrace);
  if (approvalMessages.length === 0) {
    const lines = ['Approval: not triggered in this session trace.'];
    if (session.terminationReason === 'max_steps') {
      lines.push('The run stopped before any approval-gated tool call appeared in the message trace.');
    }

    return lines;
  }

  if (approvalMessages.some((message) => {
    const metadata = asRecord(message.role === 'tool' ? message.content.metadata : undefined);
    return metadata?.approvalDenied === true;
  })) {
    return ['Approval: triggered in this session trace, and at least one request was denied.'];
  }

  return ['Approval: triggered in this session trace.'];
}

function formatMessageTrace(messages: Message[]): string[] {
  if (messages.length === 0) {
    return ['Message trace: <empty>'];
  }

  const lines = ['Message trace:'];

  messages.forEach((message, index) => {
    lines.push('');
    lines.push(...formatMessage(message, `#${index + 1}`));
  });

  return lines;
}

export function formatPendingApproval(approval: PendingToolApproval, total: number): string {
  const lines = [
    `Approval required (${total} pending)`,
    `Tool: ${approval.toolName}`,
    `Risk: ${approval.risk}`,
    `Reason: ${approval.reason}`,
  ];

  if (approval.message) {
    lines.push(`Message: ${approval.message}`);
  }

  if (approval.inputSummary) {
    lines.push('Input summary:');
    lines.push(indentBlock(approval.inputSummary));
  }

  return `${lines.join('\n')}\n`;
}

export function formatSessionSnapshot(session: AgentSession): string {
  const lines = [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Pending approvals: ${session.pendingApprovals.length}`,
  ];

  if (session.terminationReason) {
    lines.push(`Termination: ${session.terminationReason}`);
  }

  if (session.errorMessage) {
    lines.push(`Error: ${session.errorMessage}`);
  }

  return `${[
    ...lines,
    ...formatApprovalSummary(session),
    '',
    ...formatMessage(session.messages.at(-1)),
    '',
    ...formatMessageTrace(session.messages),
  ].join('\n')}\n`;
}