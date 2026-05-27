/**
 * Knowledge entry model and store - P3 priority.
 *
 * Implements the knowledge lifecycle with decay, confidence tracking,
 * and source attribution.
 */

import * as fs from 'fs';
import * as path from 'path';

export enum KnowledgeSource {
  UserCorrection = 'user_correction',
  AutoLearned = 'auto_learned',
  Imported = 'imported',
}

export enum KnowledgeStatus {
  Active = 'active',
  Archived = 'archived',
  Deprecated = 'deprecated',
  Deleted = 'deleted',
}

export interface KnowledgeEntryData {
  id: string;
  content: string;
  source?: KnowledgeSource;
  confidence?: number;
  decayRate?: number;
  createdAt?: string;
  lastAccessed?: string;
  accessCount?: number;
  status?: KnowledgeStatus;
  tags?: string[];
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

export class KnowledgeEntry {
  readonly id: string;
  content: string;
  source: KnowledgeSource;
  confidence: number;
  decayRate: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  status: KnowledgeStatus;
  tags: string[];
  projectId: string | null;
  metadata: Record<string, unknown>;

  constructor(data: KnowledgeEntryData) {
    this.id = data.id;
    this.content = data.content;
    this.source = data.source ?? KnowledgeSource.AutoLearned;
    this.confidence = data.confidence ?? 0.8;
    this.decayRate = data.decayRate ?? 0.05;
    this.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    this.lastAccessed = data.lastAccessed ? new Date(data.lastAccessed) : new Date();
    this.accessCount = data.accessCount ?? 0;
    this.status = data.status ?? KnowledgeStatus.Active;
    this.tags = data.tags ?? [];
    this.projectId = data.projectId ?? null;
    this.metadata = data.metadata ?? {};
  }

  /**
   * Calculate current knowledge value score.
   * Formula: confidence × recency_score × frequency_score
   */
  get currentValue(): number {
    const daysSinceAccess = (Date.now() - this.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-this.decayRate * daysSinceAccess);
    const frequencyScore = Math.min(this.accessCount / 10.0, 1.0);
    return this.confidence * recencyScore * frequencyScore;
  }

  /** Record an access to this knowledge entry. */
  access(): void {
    this.lastAccessed = new Date();
    this.accessCount += 1;
  }

  /** Mark entry as archived (excluded from recall). */
  archive(): void {
    this.status = KnowledgeStatus.Archived;
  }

  /** Mark entry as deprecated (superseded by newer knowledge). */
  deprecate(): void {
    this.status = KnowledgeStatus.Deprecated;
  }

  toJSON(): KnowledgeEntryData {
    return {
      id: this.id,
      content: this.content,
      source: this.source,
      confidence: this.confidence,
      decayRate: this.decayRate,
      createdAt: this.createdAt.toISOString(),
      lastAccessed: this.lastAccessed.toISOString(),
      accessCount: this.accessCount,
      status: this.status,
      tags: this.tags,
      projectId: this.projectId,
      metadata: this.metadata,
    };
  }
}

export interface KnowledgeQuery {
  projectId?: string;
  tags?: string[];
  status?: KnowledgeStatus;
  minValue?: number;
}

export class KnowledgeStore {
  private entries: Map<string, KnowledgeEntry> = new Map();
  private readonly storagePath: string | null;

  constructor(storagePath?: string) {
    this.storagePath = storagePath ?? null;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      this.load();
    }
  }

  private load(): void {
    if (!this.storagePath) return;
    const raw = fs.readFileSync(this.storagePath, 'utf-8');
    const data: KnowledgeEntryData[] = JSON.parse(raw);
    for (const entryData of data) {
      const entry = new KnowledgeEntry(entryData);
      this.entries.set(entry.id, entry);
    }
  }

  private persist(): void {
    if (!this.storagePath) return;
    const data = [...this.entries.values()].map(e => e.toJSON());
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  add(entry: KnowledgeEntry): void {
    this.entries.set(entry.id, entry);
    this.persist();
  }

  get(entryId: string): KnowledgeEntry | undefined {
    return this.entries.get(entryId);
  }

  remove(entryId: string): boolean {
    const existed = this.entries.delete(entryId);
    if (existed) this.persist();
    return existed;
  }

  query(options: KnowledgeQuery = {}): KnowledgeEntry[] {
    const { projectId, tags, status = KnowledgeStatus.Active, minValue = 0 } = options;
    const results: KnowledgeEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.status !== status) continue;
      if (projectId && entry.projectId !== projectId) continue;
      if (tags && tags.length > 0) {
        const entryTagSet = new Set(entry.tags);
        if (!tags.some(t => entryTagSet.has(t))) continue;
      }
      if (entry.currentValue < minValue) continue;
      results.push(entry);
    }

    results.sort((a, b) => b.currentValue - a.currentValue);
    return results;
  }

  getAll(includeInactive = false): KnowledgeEntry[] {
    if (includeInactive) return [...this.entries.values()];
    return [...this.entries.values()].filter(e => e.status === KnowledgeStatus.Active);
  }

  get count(): number {
    return this.entries.size;
  }
}
