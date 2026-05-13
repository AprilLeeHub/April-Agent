import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFileTools } from '../src/tools/builtin/file-tools.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('file tools', () => {
  it('reads a bounded line range from a workspace file', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-file-tools-'));
    tempDirs.push(rootDir);
    await writeFile(path.join(rootDir, 'sample.txt'), 'one\ntwo\nthree\nfour', 'utf8');
    const readFileTool = createFileTools({ rootDir }).find((tool) => tool.name === 'read_file');

    const result = await readFileTool!.execute({ path: 'sample.txt', startLine: 2, endLine: 3 }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      path: 'sample.txt',
      startLine: 2,
      endLine: 3,
      content: 'two\nthree',
    });
  });

  it('writes and edits files inside the workspace root', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-file-tools-'));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, 'nested'), { recursive: true });
    const tools = createFileTools({ rootDir });
    const writeFileTool = tools.find((tool) => tool.name === 'write_file');
    const editFileTool = tools.find((tool) => tool.name === 'edit_file');

    expect(writeFileTool?.requiresApproval?.({ path: 'nested/a.txt', content: 'hello' })).toMatchObject({
      reason: 'file_write',
      risk: 'high',
    });
    expect(editFileTool?.requiresApproval?.({ path: 'nested/a.txt', oldText: 'hello', newText: 'world' })).toMatchObject({
      reason: 'file_edit',
      risk: 'high',
    });

    await writeFileTool!.execute({ path: 'nested/a.txt', content: 'hello world' }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    });
    await editFileTool!.execute({ path: 'nested/a.txt', oldText: 'world', newText: 'runtime' }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    });

    expect(await readFile(path.join(rootDir, 'nested/a.txt'), 'utf8')).toBe('hello runtime');
  });

  it('rejects paths that escape the workspace root', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-file-tools-'));
    tempDirs.push(rootDir);
    const readFileTool = createFileTools({ rootDir }).find((tool) => tool.name === 'read_file');

    await expect(
      readFileTool!.execute({ path: '../outside.txt' }, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/escapes the workspace root/i);
  });
});