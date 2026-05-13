/**
 * Summary: Checkpoint store contracts with in-memory and local-file persistence
 * for turn-level diagnostics and future resume support.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentCheckpoint } from '../types/index.js';

export interface CheckpointStore {
  append(checkpoint: AgentCheckpoint): Promise<void>;
  list(sessionId: string): Promise<AgentCheckpoint[]>;
  latest(sessionId: string): Promise<AgentCheckpoint | undefined>;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, AgentCheckpoint[]>();

  async append(checkpoint: AgentCheckpoint): Promise<void> {
    const existing = this.checkpoints.get(checkpoint.sessionId) ?? [];
    existing.push(structuredClone(checkpoint));
    this.checkpoints.set(checkpoint.sessionId, existing);
  }

  async list(sessionId: string): Promise<AgentCheckpoint[]> {
    return structuredClone(this.checkpoints.get(sessionId) ?? []);
  }

  async latest(sessionId: string): Promise<AgentCheckpoint | undefined> {
    const checkpoints = this.checkpoints.get(sessionId);
    const checkpoint = checkpoints?.at(-1);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }
}

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly rootDir = path.resolve('.april-agent/checkpoints')) {}

  async append(checkpoint: AgentCheckpoint): Promise<void> {
    const sessionDir = path.join(this.rootDir, checkpoint.sessionId);
    await mkdir(sessionDir, { recursive: true });

    const fileName = `${checkpoint.createdAt.replaceAll(':', '-')}_${checkpoint.stage}.json`;
    await writeFile(path.join(sessionDir, fileName), JSON.stringify(checkpoint, null, 2), 'utf8');
  }

  async list(sessionId: string): Promise<AgentCheckpoint[]> {
    const sessionDir = path.join(this.rootDir, sessionId);

    try {
      const entries = (await readdir(sessionDir)).sort();
      const checkpoints = await Promise.all(
        entries.map(async (entry) => {
          const content = await readFile(path.join(sessionDir, entry), 'utf8');
          return JSON.parse(content) as AgentCheckpoint;
        }),
      );

      return checkpoints;
    } catch {
      return [];
    }
  }

  async latest(sessionId: string): Promise<AgentCheckpoint | undefined> {
    const checkpoints = await this.list(sessionId);
    return checkpoints.at(-1);
  }
}