/**
 * Summary: Local Markdown-backed memory store with simple frontmatter parsing,
 * workspace-bound path guards, and lightweight keyword search.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JsonValue, KnowledgeSearchInput, KnowledgeSnippet, MemoryEntry, MemoryStore } from '../types/index.js';
import { resolveWorkspacePath, toWorkspaceRelative } from '../tools/builtin/workspace-paths.js';

export interface LocalMarkdownStoreOptions {
  rootDir: string;
  memoryDir?: string;
  notesDirectory?: string;
}

interface ParsedMarkdownDocument {
  frontmatter: Record<string, JsonValue>;
  body: string;
}

const MARKDOWN_EXTENSION = '.md';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'memory-entry';
}

function parseFrontmatterValue(rawValue: string): JsonValue {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return '';
  }

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return trimmed;
  }
}

function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  if (!content.startsWith('---\n')) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const closingIndex = content.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const header = content.slice(4, closingIndex).trim();
  const body = content.slice(closingIndex + 5).replace(/^\n+/, '');
  const frontmatter: Record<string, JsonValue> = {};

  for (const line of header.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }

    frontmatter[key] = parseFrontmatterValue(value);
  }

  return {
    frontmatter,
    body,
  };
}

function stringifyFrontmatter(frontmatter: Record<string, JsonValue>): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (lines.length === 0) {
    return '';
  }

  return `---\n${lines.join('\n')}\n---\n\n`;
}

function toSearchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let fromIndex = 0;
  while (true) {
    const nextIndex = haystack.indexOf(needle, fromIndex);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    fromIndex = nextIndex + needle.length;
  }
}

function scoreDocument(query: string, title: string, body: string, metadata: Record<string, JsonValue>): number {
  const tokens = toSearchTokens(query);
  if (tokens.length === 0) {
    return 0;
  }

  const normalizedTitle = title.toLowerCase();
  const normalizedBody = body.toLowerCase();
  const normalizedMetadata = JSON.stringify(metadata).toLowerCase();

  return tokens.reduce((score, token) => {
    return score
      + (countOccurrences(normalizedTitle, token) * 4)
      + (countOccurrences(normalizedMetadata, token) * 2)
      + countOccurrences(normalizedBody, token);
  }, 0);
}

function buildExcerpt(body: string, query: string, maxLength = 220): string {
  const compactBody = body.replace(/\s+/g, ' ').trim();
  if (compactBody.length <= maxLength) {
    return compactBody;
  }

  const firstToken = toSearchTokens(query)[0];
  if (!firstToken) {
    return `${compactBody.slice(0, maxLength - 1)}…`;
  }

  const matchIndex = compactBody.toLowerCase().indexOf(firstToken);
  if (matchIndex === -1) {
    return `${compactBody.slice(0, maxLength - 1)}…`;
  }

  const start = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const end = Math.min(compactBody.length, start + maxLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < compactBody.length ? '…' : '';
  return `${prefix}${compactBody.slice(start, end)}${suffix}`;
}

export class LocalMarkdownStore implements MemoryStore {
  readonly name = 'local_markdown_store';

  constructor(private readonly options: LocalMarkdownStoreOptions) {}

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSnippet[]> {
    const files = await this.listMarkdownFiles();
    const { rootPath } = await this.resolveMemoryDirectory();
    const snippets: KnowledgeSnippet[] = [];

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf8');
      const parsed = parseMarkdownDocument(content);
      const title = typeof parsed.frontmatter.title === 'string'
        ? parsed.frontmatter.title
        : path.basename(filePath, MARKDOWN_EXTENSION);
      const score = scoreDocument(input.query, title, parsed.body, parsed.frontmatter);
      if (score === 0) {
        continue;
      }

      const workspaceRelativePath = toWorkspaceRelative(rootPath, filePath);
      snippets.push({
        id: typeof parsed.frontmatter.id === 'string' ? parsed.frontmatter.id : workspaceRelativePath,
        source: this.name,
        title,
        content: parsed.body,
        excerpt: buildExcerpt(parsed.body, input.query),
        score,
        path: workspaceRelativePath,
        metadata: parsed.frontmatter,
      });
    }

    return snippets
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit ?? 5);
  }

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    const relativeMemoryPath = entry.path ?? path.join(this.options.notesDirectory ?? 'notes', `${slugify(entry.id)}${MARKDOWN_EXTENSION}`);
    const timestamp = entry.updatedAt || new Date().toISOString();
    const { rootPath, resolvedPath } = await resolveWorkspacePath(
      this.options.rootDir,
      path.join(this.options.memoryDir ?? '.april-agent/memory', relativeMemoryPath),
      { allowMissing: true },
    );

    await mkdir(path.dirname(resolvedPath), { recursive: true });

    // Frontmatter 保持 JSON 子集，避免额外引入 YAML 依赖也能支撑可配置元数据扩展。
    const frontmatter: Record<string, JsonValue> = {
      id: entry.id,
      title: entry.title,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: timestamp,
      ...(entry.metadata ?? {}),
    };

    await writeFile(
      resolvedPath,
      `${stringifyFrontmatter(frontmatter)}${entry.content.trimEnd()}\n`,
      'utf8',
    );

    return {
      ...entry,
      updatedAt: timestamp,
      path: toWorkspaceRelative(rootPath, resolvedPath),
    };
  }

  async delete(id: string): Promise<boolean> {
    const files = await this.listMarkdownFiles();

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf8');
      const parsed = parseMarkdownDocument(content);
      const fileName = path.basename(filePath, MARKDOWN_EXTENSION);
      const storedId = typeof parsed.frontmatter.id === 'string' ? parsed.frontmatter.id : fileName;
      if (storedId !== id && fileName !== slugify(id)) {
        continue;
      }

      await unlink(filePath);
      return true;
    }

    return false;
  }

  private async resolveMemoryDirectory(): Promise<{ rootPath: string; resolvedPath: string }> {
    return resolveWorkspacePath(this.options.rootDir, this.options.memoryDir ?? '.april-agent/memory', { allowMissing: true });
  }

  private async listMarkdownFiles(): Promise<string[]> {
    const { resolvedPath } = await this.resolveMemoryDirectory();
    return this.walkMarkdownFiles(resolvedPath);
  }

  private async walkMarkdownFiles(directoryPath: string): Promise<string[]> {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          files.push(...await this.walkMarkdownFiles(entryPath));
          continue;
        }

        if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) {
          files.push(entryPath);
        }
      }

      return files;
    } catch {
      return [];
    }
  }
}