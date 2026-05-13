/**
 * Summary: Built-in search and navigation tools for bounded directory listing
 * and grep-style text matching across workspace files.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from '../../types/index.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace-paths.js';

interface SearchToolOptions {
  rootDir: string;
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);

function ensureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool input must be an object.');
  }

  return input as Record<string, unknown>;
}

async function walkFiles(startPath: string): Promise<string[]> {
  const entries = await readdir(startPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      files.push(...await walkFiles(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export function createSearchTools(options: SearchToolOptions): ToolDefinition[] {
  return [
    {
      name: 'list_dir',
      description: 'List files and directories under a workspace-relative path.',
      outputKind: 'search',
      validate: (input) => {
        const payload = ensureObject(input);
        if (payload.path !== undefined && typeof payload.path !== 'string') {
          throw new Error('list_dir path must be a string when provided.');
        }
      },
      execute: async (input) => {
        const payload = ensureObject(input);
        const requestedPath = typeof payload.path === 'string' ? payload.path : '.';
        const { rootPath, resolvedPath } = await resolveWorkspacePath(options.rootDir, requestedPath);
        const entries = await readdir(resolvedPath, { withFileTypes: true });

        const items = await Promise.all(entries.map(async (entry) => {
          const entryPath = path.join(resolvedPath, entry.name);
          const entryStat = await stat(entryPath);
          return {
            name: entry.name,
            path: toWorkspaceRelative(rootPath, entryPath),
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entryStat.size,
          };
        }));

        return {
          path: toWorkspaceRelative(rootPath, resolvedPath),
          items,
        };
      },
    },
    {
      name: 'grep_search',
      description: 'Search workspace files for a plain-text or regular-expression pattern.',
      outputKind: 'search',
      validate: (input) => {
        const payload = ensureObject(input);
        if (typeof payload.query !== 'string' || payload.query.length === 0) {
          throw new Error('grep_search requires a non-empty query string.');
        }

        if (payload.path !== undefined && typeof payload.path !== 'string') {
          throw new Error('grep_search path must be a string when provided.');
        }
      },
      execute: async (input) => {
        const payload = ensureObject(input);
        const query = payload.query as string;
        const requestedPath = typeof payload.path === 'string' ? payload.path : '.';
        const isRegexp = payload.isRegexp === true;
        const maxResults = typeof payload.maxResults === 'number' && payload.maxResults > 0
          ? Math.floor(payload.maxResults)
          : 50;
        const { rootPath, resolvedPath } = await resolveWorkspacePath(options.rootDir, requestedPath);
        const pattern = isRegexp ? new RegExp(query, 'i') : undefined;
        const files = await walkFiles(resolvedPath);
        const matches: Array<{ path: string; line: number; excerpt: string }> = [];

        for (const filePath of files) {
          if (matches.length >= maxResults) {
            break;
          }

          let content: string;
          try {
            content = await readFile(filePath, 'utf8');
          } catch {
            continue;
          }

          const lines = content.split(/\r?\n/);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex] ?? '';
            const matched = isRegexp
              ? pattern!.test(line)
              : line.toLowerCase().includes(query.toLowerCase());

            if (!matched) {
              continue;
            }

            matches.push({
              path: toWorkspaceRelative(rootPath, filePath),
              line: lineIndex + 1,
              excerpt: line.trim(),
            });

            if (matches.length >= maxResults) {
              break;
            }
          }
        }

        return {
          query,
          isRegexp,
          results: matches,
          truncated: matches.length >= maxResults,
        };
      },
    },
  ];
}