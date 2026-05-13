/**
 * Summary: Artifact store contracts with in-memory and local-file backends for
 * oversized tool outputs that should not be echoed into model context.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createMessageId, createTimestamp } from '../types/messages.js';
import type { ArtifactRecord } from '../types/index.js';

export interface ArtifactStore {
  write(input: { toolName: string; content: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord>;
  get(id: string): Promise<ArtifactRecord | undefined>;
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();

  async write(input: { toolName: string; content: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord> {
    const artifact: ArtifactRecord = {
      id: createMessageId('artifact'),
      createdAt: createTimestamp(),
      toolName: input.toolName,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    this.artifacts.set(artifact.id, structuredClone(artifact));
    return structuredClone(artifact);
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    const artifact = this.artifacts.get(id);
    return artifact ? structuredClone(artifact) : undefined;
  }
}

export class LocalFileArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir = path.resolve('.april-agent/artifacts')) {}

  async write(input: { toolName: string; content: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord> {
    await mkdir(this.rootDir, { recursive: true });

    const artifact: ArtifactRecord = {
      id: createMessageId('artifact'),
      createdAt: createTimestamp(),
      toolName: input.toolName,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    const filePath = path.join(this.rootDir, `${artifact.id}.json`);
    await writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf8');
    return artifact;
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    const filePath = path.join(this.rootDir, `${id}.json`);

    try {
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content) as ArtifactRecord;
    } catch {
      return undefined;
    }
  }
}