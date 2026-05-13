/**
 * Summary: Built-in file tools for bounded reading, approved writing, and
 * precise text replacement inside the workspace root.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from '../../types/index.js';
import { resolveWorkspacePath, resolveWorkspaceRoot, toWorkspaceRelative } from './workspace-paths.js';

interface FileToolOptions {
  rootDir: string;
}

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface WriteFileInput {
  path: string;
  content: string;
}

interface Replacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface EditFileInput {
  path: string;
  oldText?: string;
  newText?: string;
  replacements?: Replacement[];
}

function ensureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool input must be an object.');
  }

  return input as Record<string, unknown>;
}

function parseReadFileInput(input: unknown): ReadFileInput {
  const payload = ensureObject(input);
  if (typeof payload.path !== 'string' || payload.path.length === 0) {
    throw new Error('read_file requires a non-empty path string.');
  }

  const startLine = payload.startLine;
  const endLine = payload.endLine;
  if (startLine !== undefined && (!Number.isInteger(startLine) || Number(startLine) < 1)) {
    throw new Error('startLine must be a positive integer when provided.');
  }

  if (endLine !== undefined && (!Number.isInteger(endLine) || Number(endLine) < 1)) {
    throw new Error('endLine must be a positive integer when provided.');
  }

  return {
    path: payload.path,
    ...(startLine !== undefined ? { startLine: Number(startLine) } : {}),
    ...(endLine !== undefined ? { endLine: Number(endLine) } : {}),
  };
}

function parseWriteFileInput(input: unknown): WriteFileInput {
  const payload = ensureObject(input);
  if (typeof payload.path !== 'string' || payload.path.length === 0) {
    throw new Error('write_file requires a non-empty path string.');
  }

  if (typeof payload.content !== 'string') {
    throw new Error('write_file requires content as a string.');
  }

  return {
    path: payload.path,
    content: payload.content,
  };
}

function parseEditFileInput(input: unknown): EditFileInput {
  const payload = ensureObject(input);
  if (typeof payload.path !== 'string' || payload.path.length === 0) {
    throw new Error('edit_file requires a non-empty path string.');
  }

  const replacements = payload.replacements;
  if (Array.isArray(replacements)) {
    const parsedReplacements = replacements.map((replacement) => {
      const record = ensureObject(replacement);
      if (typeof record.oldText !== 'string' || typeof record.newText !== 'string') {
        throw new Error('Each replacement must include oldText and newText strings.');
      }

      return {
        oldText: record.oldText,
        newText: record.newText,
        ...(record.replaceAll === true ? { replaceAll: true } : {}),
      } satisfies Replacement;
    });

    return {
      path: payload.path,
      replacements: parsedReplacements,
    };
  }

  if (typeof payload.oldText !== 'string' || typeof payload.newText !== 'string') {
    throw new Error('edit_file requires oldText/newText strings or a replacements array.');
  }

  return {
    path: payload.path,
    oldText: payload.oldText,
    newText: payload.newText,
  };
}

function applyReplacement(content: string, replacement: Replacement): { nextContent: string; occurrences: number } {
  const occurrences = content.split(replacement.oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(`Could not find the target text: ${replacement.oldText.slice(0, 80)}`);
  }

  if (!replacement.replaceAll && occurrences !== 1) {
    throw new Error(`Target text matched ${occurrences} times; expected exactly once.`);
  }

  return {
    nextContent: replacement.replaceAll
      ? content.split(replacement.oldText).join(replacement.newText)
      : content.replace(replacement.oldText, replacement.newText),
    occurrences,
  };
}

export function createFileTools(options: FileToolOptions): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from the workspace, optionally narrowing to a line range.',
      outputKind: 'read-file',
      validate: (input) => {
        parseReadFileInput(input);
      },
      execute: async (input) => {
        const readInput = parseReadFileInput(input);
        const { rootPath, resolvedPath } = await resolveWorkspacePath(options.rootDir, readInput.path);
        const content = await readFile(resolvedPath, 'utf8');
        const lines = content.split(/\r?\n/);

        if (readInput.startLine === undefined && readInput.endLine === undefined) {
          return content;
        }

        const startLine = readInput.startLine ?? 1;
        const endLine = readInput.endLine ?? lines.length;
        if (endLine < startLine) {
          throw new Error('endLine must be greater than or equal to startLine.');
        }

        return {
          path: toWorkspaceRelative(rootPath, resolvedPath),
          startLine,
          endLine,
          content: lines.slice(startLine - 1, endLine).join('\n'),
        };
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file inside the workspace root.',
      requiresApproval: () => ({
        reason: 'file_write',
        risk: 'high',
        message: 'write_file requires explicit approval before modifying workspace files.',
      }),
      validate: (input) => {
        parseWriteFileInput(input);
      },
      execute: async (input) => {
        const writeInput = parseWriteFileInput(input);
        const { rootPath, resolvedPath } = await resolveWorkspacePath(options.rootDir, writeInput.path, { allowMissing: true });
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, writeInput.content, 'utf8');

        return {
          path: toWorkspaceRelative(rootPath, resolvedPath),
          bytesWritten: Buffer.byteLength(writeInput.content, 'utf8'),
          linesWritten: writeInput.content === '' ? 0 : writeInput.content.split(/\r?\n/).length,
        };
      },
    },
    {
      name: 'edit_file',
      description: 'Apply precise in-file replacements without rewriting unrelated content.',
      requiresApproval: () => ({
        reason: 'file_edit',
        risk: 'high',
        message: 'edit_file requires explicit approval before modifying workspace files.',
      }),
      validate: (input) => {
        parseEditFileInput(input);
      },
      execute: async (input) => {
        const editInput = parseEditFileInput(input);
        const { rootPath, resolvedPath } = await resolveWorkspacePath(options.rootDir, editInput.path);
        const originalContent = await readFile(resolvedPath, 'utf8');

        const replacements = editInput.replacements ?? [
          {
            oldText: editInput.oldText!,
            newText: editInput.newText!,
          },
        ];

        let nextContent = originalContent;
        let totalReplacements = 0;

        // Apply replacements sequentially so later edits see earlier changes.
        for (const replacement of replacements) {
          const result = applyReplacement(nextContent, replacement);
          nextContent = result.nextContent;
          totalReplacements += result.occurrences;
        }

        await writeFile(resolvedPath, nextContent, 'utf8');
        return {
          path: toWorkspaceRelative(rootPath, resolvedPath),
          replacementsApplied: totalReplacements,
          changed: nextContent !== originalContent,
        };
      },
    },
  ];
}

export async function getWorkspaceRoot(rootDir: string): Promise<string> {
  return resolveWorkspaceRoot(rootDir);
}