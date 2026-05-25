/**
 * Summary: Facade tools that expose memory recall and persistence without
 * leaking direct filesystem details into the model-facing tool surface.
 */

import type { MemoryOrchestrator } from '../../knowledge/orchestrator.js';
import type { JsonValue, MemoryEntry, ToolDefinition } from '../../types/index.js';

export interface MemoryFacadeToolOptions {
  orchestrator: MemoryOrchestrator;
}

interface SearchKnowledgeInput {
  query: string;
  limit?: number;
}

interface SaveToMemoryInput {
  id?: string;
  title?: string;
  content: string;
  path?: string;
  metadata?: Record<string, JsonValue>;
}

interface DeleteFromMemoryInput {
  id: string;
}

function ensureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool input must be an object.');
  }

  return input as Record<string, unknown>;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'memory-entry';
}

function asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, JsonValue>;
}

function parseSearchKnowledgeInput(input: unknown): SearchKnowledgeInput {
  const payload = ensureObject(input);
  if (typeof payload.query !== 'string' || payload.query.trim().length === 0) {
    throw new Error('search_knowledge requires a non-empty query string.');
  }

  if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || Number(payload.limit) < 1)) {
    throw new Error('search_knowledge limit must be a positive integer when provided.');
  }

  return {
    query: payload.query.trim(),
    ...(payload.limit !== undefined ? { limit: Number(payload.limit) } : {}),
  };
}

function parseSaveToMemoryInput(input: unknown): SaveToMemoryInput {
  const payload = ensureObject(input);
  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
    throw new Error('save_to_memory requires non-empty content.');
  }

  if (payload.id !== undefined && typeof payload.id !== 'string') {
    throw new Error('save_to_memory id must be a string when provided.');
  }

  if (payload.title !== undefined && typeof payload.title !== 'string') {
    throw new Error('save_to_memory title must be a string when provided.');
  }

  if (payload.path !== undefined && typeof payload.path !== 'string') {
    throw new Error('save_to_memory path must be a string when provided.');
  }

  const metadata = payload.metadata !== undefined ? asJsonRecord(payload.metadata) : undefined;
  if (payload.metadata !== undefined && !metadata) {
    throw new Error('save_to_memory metadata must be a JSON object when provided.');
  }

  return {
    ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    content: payload.content.trim(),
    ...(typeof payload.path === 'string' ? { path: payload.path } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseDeleteFromMemoryInput(input: unknown): DeleteFromMemoryInput {
  const payload = ensureObject(input);
  if (typeof payload.id !== 'string' || payload.id.trim().length === 0) {
    throw new Error('delete_from_memory requires a non-empty id string.');
  }

  return {
    id: payload.id.trim(),
  };
}

function buildMemoryEntry(input: SaveToMemoryInput): MemoryEntry {
  const now = new Date().toISOString();
  const id = input.id ?? slugify(input.title ?? input.content.slice(0, 48));
  return {
    id,
    title: input.title ?? id,
    content: input.content,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    ...(input.path ? { path: input.path } : {}),
    metadata: {
      kind: 'note',
      ...(input.metadata ?? {}),
    },
  };
}

export function createMemoryFacadeTools(options: MemoryFacadeToolOptions): ToolDefinition[] {
  return [
    {
      name: 'search_knowledge',
      description: 'Search local memory and attached knowledge sources for relevant notes and prior decisions.',
      outputKind: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query to search inside memory.' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      validate: (input) => {
        parseSearchKnowledgeInput(input);
      },
      execute: async (input, context) => {
        const searchInput = parseSearchKnowledgeInput(input);
        const results = await options.orchestrator.search(
          searchInput,
          {
            sessionId: context.sessionId,
            turnId: context.turnId,
            signal: context.signal,
          },
        );

        return {
          query: searchInput.query,
          results: results.map((result) => ({
            id: result.id,
            title: result.title,
            source: result.source,
            score: result.score,
            excerpt: result.excerpt,
            ...(result.path ? { path: result.path } : {}),
          })),
        };
      },
    },
    {
      name: 'save_to_memory',
      description: 'Persist a compact note or decision into the local memory knowledge base.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable identifier for the memory entry.' },
          title: { type: 'string', description: 'Human-readable title for the memory entry.' },
          content: { type: 'string', description: 'Markdown body to store.' },
          path: { type: 'string', description: 'Optional custom relative path under the memory directory.' },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['content'],
        additionalProperties: false,
      },
      validate: (input) => {
        parseSaveToMemoryInput(input);
      },
      execute: async (input) => {
        const saveInput = parseSaveToMemoryInput(input);
        const saved = await options.orchestrator.save(buildMemoryEntry(saveInput));

        // 这些工具默认静默执行，不声明 requiresApproval，从而保持主流 agent 的低摩擦体验。
        return {
          saved: true,
          id: saved.id,
          title: saved.title,
          ...(saved.path ? { path: saved.path } : {}),
          metadata: saved.metadata ?? {},
        };
      },
    },
    {
      name: 'delete_from_memory',
      description: 'Delete a previously saved local memory entry by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Identifier of the memory entry to delete.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      validate: (input) => {
        parseDeleteFromMemoryInput(input);
      },
      execute: async (input) => {
        const deleteInput = parseDeleteFromMemoryInput(input);
        const deleted = await options.orchestrator.delete(deleteInput.id);

        return {
          id: deleteInput.id,
          deleted,
        };
      },
    },
  ];
}