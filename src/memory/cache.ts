/**
 * Cache layers for token optimization - P4 priority.
 *
 * L1: Session-scoped hot cache (in-memory LRU)
 * L2: Cross-session warm cache (persistent, TTL-based)
 */

import * as fs from 'fs';
import * as path from 'path';

interface CacheEntry {
  key: string;
  value: string;
  createdAt: number;
  ttl: number; // 0 means no expiration (session-scoped)
  hitCount: number;
}

function isExpired(entry: CacheEntry): boolean {
  if (entry.ttl <= 0) return false;
  return (Date.now() - entry.createdAt) > entry.ttl * 1000;
}

/**
 * L1 Session Hot Cache - in-memory LRU.
 * Stores frequently accessed query results within a single session.
 */
export class SessionCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // Move to end (most recently used) - delete and re-insert
    this.cache.delete(key);
    entry.hitCount++;
    this.cache.set(key, entry);
    return entry.value;
  }

  put(key: string, value: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove LRU (first entry)
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { key, value, createdAt: Date.now(), ttl: 0, hitCount: 0 });
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

interface CrossSessionCacheConfig {
  storagePath?: string;
  defaultTtl?: number; // seconds, default 7 days
  maxSize?: number;
}

/**
 * L2 Cross-Session Warm Cache - persistent with TTL.
 * Uses (userId, projectId, query) as composite key.
 */
export class CrossSessionCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly storagePath: string | null;
  private readonly defaultTtl: number;
  private readonly maxSize: number;

  constructor(config: CrossSessionCacheConfig = {}) {
    this.storagePath = config.storagePath ?? null;
    this.defaultTtl = config.defaultTtl ?? 7 * 24 * 3600;
    this.maxSize = config.maxSize ?? 1000;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      this.load();
    }
  }

  private makeKey(userId: string, projectId: string, query: string): string {
    return `${userId}:${projectId}:${query}`;
  }

  get(userId: string, projectId: string, query: string): string | undefined {
    const key = this.makeKey(userId, projectId, query);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (isExpired(entry)) {
      this.cache.delete(key);
      this.persist();
      return undefined;
    }
    entry.hitCount++;
    return entry.value;
  }

  put(userId: string, projectId: string, query: string, value: string, ttl?: number): void {
    const key = this.makeKey(userId, projectId, query);
    this.cache.set(key, {
      key,
      value,
      createdAt: Date.now(),
      ttl: ttl ?? this.defaultTtl,
      hitCount: 0,
    });
    this.evictIfNeeded();
    this.persist();
  }

  invalidate(userId: string, projectId: string, query: string): boolean {
    const key = this.makeKey(userId, projectId, query);
    const existed = this.cache.delete(key);
    if (existed) this.persist();
    return existed;
  }

  invalidateProject(projectId: string): number {
    const toRemove: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(`:${projectId}:`)) toRemove.push(key);
    }
    for (const key of toRemove) this.cache.delete(key);
    if (toRemove.length > 0) this.persist();
    return toRemove.length;
  }

  cleanupExpired(): number {
    const expired: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (isExpired(entry)) expired.push(key);
    }
    for (const key of expired) this.cache.delete(key);
    if (expired.length > 0) this.persist();
    return expired.length;
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxSize) return;
    this.cleanupExpired();
    while (this.cache.size > this.maxSize) {
      // Remove entry with lowest hit count
      let minKey: string | null = null;
      let minHits = Infinity;
      for (const [key, entry] of this.cache.entries()) {
        if (entry.hitCount < minHits) {
          minHits = entry.hitCount;
          minKey = key;
        }
      }
      if (minKey) this.cache.delete(minKey);
      else break;
    }
  }

  private load(): void {
    if (!this.storagePath) return;
    const raw = fs.readFileSync(this.storagePath, 'utf-8');
    const data: CacheEntry[] = JSON.parse(raw);
    for (const item of data) {
      if (!isExpired(item)) {
        this.cache.set(item.key, item);
      }
    }
  }

  private persist(): void {
    if (!this.storagePath) return;
    const data = [...this.cache.values()];
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  get size(): number {
    return this.cache.size;
  }
}
