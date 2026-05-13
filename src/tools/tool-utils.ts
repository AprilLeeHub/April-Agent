/**
 * Summary: Shared helpers for policy evaluation, receipts, and tool-output
 * summarization.
 */

import { createHash } from 'node:crypto';

import type { ToolCall } from '../types/index.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

export function summarizeText(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

export function buildToolCallSignature(toolCall: Pick<ToolCall, 'name' | 'input'>): string {
  const hash = createHash('sha256');
  hash.update(toolCall.name);
  hash.update('\0');
  hash.update(stableStringify(toolCall.input));
  return hash.digest('hex');
}