/**
 * Summary: Shared message and tool protocol types, including strict adjacency
 * checks for assistant tool calls and the following tool results.
 */

import { z } from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface BaseMessage {
  id: string;
  role: MessageRole;
  createdAt: string;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface ToolResultContent {
  text: string;
  summary: string;
  truncated: boolean;
  artifactId?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: ToolResultContent;
}

export type ToolResultMessage = ToolMessage;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolChainReceipt {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  resultSummary: string;
  isError: boolean;
  artifactId?: string;
}

export interface SummaryMessage extends BaseMessage {
  role: 'system';
  content: string;
  kind: 'synthetic-summary';
}

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.any(),
});

export const assistantMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('assistant'),
  createdAt: z.string().min(1),
  content: z.string(),
  reasoningContent: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'error']).optional(),
});

export const toolMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('tool'),
  createdAt: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  isError: z.boolean(),
  content: z.object({
    text: z.string(),
    summary: z.string(),
    truncated: z.boolean(),
    artifactId: z.string().optional(),
    metadata: z.record(z.any()).optional(),
  }),
});

export class MessageProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageProtocolError';
  }
}

export function isAssistantToolCallMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

export function hasOpenToolChain(messages: Message[]): boolean {
  const lastMessage = messages.at(-1);
  return Boolean(lastMessage && isAssistantToolCallMessage(lastMessage));
}

export function assertToolChainAdjacency(messages: Message[]): void {
  let openToolCalls: ToolCall[] = [];

  for (const message of messages) {
    if (openToolCalls.length > 0) {
      if (message.role !== 'tool') {
        throw new MessageProtocolError(
          `Expected tool result after assistant tool_calls, received ${message.role}.`,
        );
      }

      const expectedCall = openToolCalls.shift();
      if (!expectedCall || message.toolCallId !== expectedCall.id) {
        throw new MessageProtocolError(
          `Tool result ${message.toolCallId} does not match expected tool call ${expectedCall?.id ?? 'unknown'}.`,
        );
      }

      continue;
    }

    if (isAssistantToolCallMessage(message)) {
      openToolCalls = [...(message.toolCalls ?? [])];
    }
  }

  if (openToolCalls.length > 0) {
    throw new MessageProtocolError('Assistant tool_calls must be followed by matching tool results.');
  }
}

export const validateMessageSequence = assertToolChainAdjacency;

export function cloneMessages(messages: Message[]): Message[] {
  return messages.map((message) => structuredClone(message));
}

export function createMessageId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
  options: {
    isError?: boolean;
    summary?: string;
    truncated?: boolean;
    artifactId?: string;
    metadata?: Record<string, JsonValue>;
  } = {},
): ToolMessage {
  const content: ToolResultContent = {
    text,
    summary: options.summary ?? text.slice(0, 200),
    truncated: options.truncated ?? false,
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  return {
    id: createMessageId('tool'),
    role: 'tool',
    createdAt: createTimestamp(),
    toolCallId,
    toolName,
    isError: options.isError ?? false,
    content,
  };
}