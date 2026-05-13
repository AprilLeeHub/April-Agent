import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSearchTools } from '../src/tools/builtin/search-tools.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('search tools', () => {
  it('lists directory entries inside the workspace root', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-search-tools-'));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, 'src'));
    await writeFile(path.join(rootDir, 'src/app.ts'), 'export const app = true;', 'utf8');
    const listDirTool = createSearchTools({ rootDir }).find((tool) => tool.name === 'list_dir');

    const result = await listDirTool!.execute({ path: 'src' }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      path: 'src',
      items: [
        {
          name: 'app.ts',
          path: 'src/app.ts',
          type: 'file',
        },
      ],
    });
  });

  it('finds grep-style matches across workspace files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-search-tools-'));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, 'src'));
    await writeFile(path.join(rootDir, 'src/a.ts'), 'const target = 1;\nexport { target };', 'utf8');
    await writeFile(path.join(rootDir, 'src/b.ts'), 'const other = 2;', 'utf8');
    const grepTool = createSearchTools({ rootDir }).find((tool) => tool.name === 'grep_search');

    const result = await grepTool!.execute({ query: 'target', path: 'src' }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      query: 'target',
      isRegexp: false,
    });
    expect((result as { results: Array<{ path: string }> }).results).toEqual([
      { path: 'src/a.ts', line: 1, excerpt: 'const target = 1;' },
      { path: 'src/a.ts', line: 2, excerpt: 'export { target };' },
    ]);
  });
});