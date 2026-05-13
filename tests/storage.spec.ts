import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryArtifactStore, LocalFileArtifactStore } from '../src/storage/artifact-store.js';
import { FileCheckpointStore, MemoryCheckpointStore } from '../src/storage/checkpoint-store.js';
import { MemorySessionStore } from '../src/storage/session-store.js';
import { createSession } from '../src/types/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MemorySessionStore', () => {
  it('round-trips sessions without mutating stored order', async () => {
    const store = new MemorySessionStore();
    const session = await store.create('session-store-1');
    session.messages.push({ id: 'user-1', role: 'user', createdAt: new Date().toISOString(), content: 'hello' });
    await store.save(session);

    const loaded = await store.get(session.id);
    expect(loaded?.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });
});

describe('CheckpointStore', () => {
  it('keeps checkpoints in append order for memory and file backends', async () => {
    const checkpoint = {
      sessionId: 'session-store-2',
      turnId: 'turn-1',
      stage: 'turn_start' as const,
      session: createSession('session-store-2'),
      createdAt: new Date().toISOString(),
      decisionEvents: [],
    };

    const memory = new MemoryCheckpointStore();
    await memory.append(checkpoint);
    expect((await memory.latest('session-store-2'))?.stage).toBe('turn_start');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-checkpoints-'));
    tempDirs.push(tempDir);
    const files = new FileCheckpointStore(tempDir);
    await files.append(checkpoint);
    expect((await files.latest('session-store-2'))?.stage).toBe('turn_start');
  });
});

describe('ArtifactStore', () => {
  it('stores artifacts in memory and on disk', async () => {
    const memory = new MemoryArtifactStore();
    const stored = await memory.write({ toolName: 'search', content: 'result' });
    expect((await memory.get(stored.id))?.content).toBe('result');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'april-agent-artifacts-'));
    tempDirs.push(tempDir);
    const files = new LocalFileArtifactStore(tempDir);
    const fileArtifact = await files.write({ toolName: 'search', content: 'result-2' });
    expect((await files.get(fileArtifact.id))?.content).toBe('result-2');
  });
});