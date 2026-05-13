/**
 * Summary: Optional DeepSeek tokenizer bridge that loads local Hugging Face
 * tokenizer assets and estimates prompt tokens from runtime message history.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';

import type { Message, ToolCall } from '../types/index.js';

interface DeepSeekTokenizerConfig {
  bos_token?: {
    content?: string;
  };
  eos_token?: {
    content?: string;
  };
}

export interface TokenEstimateDetails {
  source: 'deepseek_tokenizer' | 'char_approx';
  mode: 'exact' | 'approximate';
}

export interface DeepSeekTokenCounter {
  countMessages(messages: Message[], extra?: Record<string, unknown>): number;
  countText(text: string): number;
  describe(): TokenEstimateDetails;
}

export function createDeepSeekTokenCounter(tokenizerDir: string): DeepSeekTokenCounter {
  const tokenizerPath = resolve(tokenizerDir, 'tokenizer.json');
  const configPath = resolve(tokenizerDir, 'tokenizer_config.json');

  try {
    const tokenizerJson = JSON.parse(readFileSync(tokenizerPath, 'utf8')) as object;
    const tokenizerConfig = JSON.parse(readFileSync(configPath, 'utf8')) as DeepSeekTokenizerConfig & object;

    return new LocalDeepSeekTokenCounter(
      new Tokenizer(tokenizerJson, tokenizerConfig),
      tokenizerConfig.bos_token?.content ?? '',
      tokenizerConfig.eos_token?.content ?? '<｜end▁of▁sentence｜>',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load DeepSeek tokenizer assets from ${tokenizerDir}: ${message}`);
  }
}

class LocalDeepSeekTokenCounter implements DeepSeekTokenCounter {
  constructor(
    private readonly tokenizer: Tokenizer,
    private readonly bosToken: string,
    private readonly eosToken: string,
  ) {}

  countMessages(messages: Message[], extra?: Record<string, unknown>): number {
    const transcript = renderDeepSeekTranscript(messages, {
      bosToken: this.bosToken,
      eosToken: this.eosToken,
      addGenerationPrompt: true,
    });
    const extraPayload = extra ? JSON.stringify(extra) : '';

    return this.countText(transcript) + (extraPayload ? this.countText(extraPayload) : 0);
  }

  countText(text: string): number {
    return this.tokenizer.encode(text).ids.length;
  }

  describe(): TokenEstimateDetails {
    return {
      source: 'deepseek_tokenizer',
      mode: 'exact',
    };
  }
}

export function renderDeepSeekTranscript(
  messages: Message[],
  options: {
    bosToken: string;
    eosToken: string;
    addGenerationPrompt?: boolean;
  },
): string {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  let transcript = `${options.bosToken}${systemPrompt}`;
  let toolOutputOpen = false;
  let firstToolOutput = true;

  const closeToolOutputsIfNeeded = () => {
    if (!toolOutputOpen) {
      return;
    }

    transcript += '<｜tool▁outputs▁end｜>';
    toolOutputOpen = false;
    firstToolOutput = true;
  };

  for (const message of messages) {
    if (message.role !== 'tool') {
      closeToolOutputsIfNeeded();
    }

    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'user') {
      transcript += `<｜User｜>${message.content}`;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      transcript += renderAssistantToolCalls(message.content, message.toolCalls);
      continue;
    }

    if (message.role === 'assistant') {
      transcript += `<｜Assistant｜>${stripThinking(message.content)}${options.eosToken}`;
      continue;
    }

    // 这里显式闭合 tool output 片段，避免中间插入人工消息时破坏 transcript 结构。
    if (!toolOutputOpen) {
      transcript += '<｜tool▁outputs▁begin｜>';
      toolOutputOpen = true;
      firstToolOutput = true;
    }

    transcript += firstToolOutput
      ? `<｜tool▁output▁begin｜>${message.content.text}<｜tool▁output▁end｜>`
      : `<｜tool▁output▁begin｜>${message.content.text}<｜tool▁output▁end｜>`;
    firstToolOutput = false;
  }

  closeToolOutputsIfNeeded();
  if (options.addGenerationPrompt) {
    transcript += '<｜Assistant｜>';
  }

  return transcript;
}

function renderAssistantToolCalls(content: string, toolCalls: ToolCall[]): string {
  let segment = '<｜Assistant｜>';
  if (content) {
    segment += content;
  }

  segment += '<｜tool▁calls▁begin｜>';
  segment += toolCalls
    .map((toolCall) => renderToolCall(toolCall))
    .join('\n');
  segment += `<｜tool▁calls▁end｜><｜end▁of▁sentence｜>`;
  return segment;
}

function renderToolCall(toolCall: ToolCall): string {
  return [
    '<｜tool▁call▁begin｜>function<｜tool▁sep｜>',
    toolCall.name,
    '\n```json\n',
    JSON.stringify(toolCall.input),
    '\n```<｜tool▁call▁end｜>',
  ].join('');
}

function stripThinking(content: string): string {
  const marker = '</think>';
  const markerIndex = content.lastIndexOf(marker);
  return markerIndex === -1 ? content : content.slice(markerIndex + marker.length);
}