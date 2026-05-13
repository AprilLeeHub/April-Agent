/**
 * Summary: Workspace-root path guards for built-in tools so reads, writes, and
 * searches stay inside the configured repository boundary.
 */

import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findNearestExistingParent(targetPath: string): Promise<string> {
  let currentPath = targetPath;

  while (!(await pathExists(currentPath))) {
    const nextPath = path.dirname(currentPath);
    if (nextPath === currentPath) {
      throw new Error(`No existing parent path found for ${targetPath}.`);
    }

    currentPath = nextPath;
  }

  return currentPath;
}

function assertWithinRoot(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path ${targetPath} escapes the workspace root ${rootPath}.`);
  }
}

export async function resolveWorkspaceRoot(rootDir: string): Promise<string> {
  return realpath(rootDir);
}

export async function resolveWorkspacePath(
  rootDir: string,
  requestedPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<{ rootPath: string; resolvedPath: string }> {
  const rootPath = await resolveWorkspaceRoot(rootDir);
  const candidatePath = path.resolve(rootPath, requestedPath);
  assertWithinRoot(rootPath, candidatePath);

  if (options.allowMissing) {
    const existingParent = await findNearestExistingParent(path.dirname(candidatePath));
    const realParent = await realpath(existingParent);
    assertWithinRoot(rootPath, realParent);
    return {
      rootPath,
      resolvedPath: candidatePath,
    };
  }

  const realCandidatePath = await realpath(candidatePath);
  assertWithinRoot(rootPath, realCandidatePath);
  return {
    rootPath,
    resolvedPath: realCandidatePath,
  };
}

export function toWorkspaceRelative(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath) || '.';
}