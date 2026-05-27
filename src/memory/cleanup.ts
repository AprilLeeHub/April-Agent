/**
 * Knowledge cleanup module - P3 priority.
 *
 * Implements periodic knowledge maintenance:
 * - Value-based decay and archival
 * - Contradiction detection
 * - Capacity management
 * - Source validity checking
 */

import { KnowledgeEntry, KnowledgeStore, KnowledgeStatus } from './knowledge';

export interface CleanupReport {
  timestamp: string;
  archivedCount: number;
  deprecatedCount: number;
  deletedCount: number;
  contradictionsFound: number;
  totalScanned: number;
}

export function cleanupReportSummary(report: CleanupReport): string {
  return [
    `Cleanup Report (${report.timestamp}):`,
    `  Scanned: ${report.totalScanned}`,
    `  Archived: ${report.archivedCount}`,
    `  Deprecated: ${report.deprecatedCount}`,
    `  Deleted: ${report.deletedCount}`,
    `  Contradictions: ${report.contradictionsFound}`,
  ].join('\n');
}

export type ContradictionFn = (a: string, b: string) => boolean;

export interface KnowledgeCleanerConfig {
  valueThreshold?: number;
  capacityLimit?: number;
  gracePeriodDays?: number;
  contradictionFn?: ContradictionFn;
}

export class KnowledgeCleaner {
  private readonly store: KnowledgeStore;
  private readonly valueThreshold: number;
  private readonly capacityLimit: number;
  private readonly gracePeriodDays: number;
  private readonly contradictionFn: ContradictionFn;

  constructor(store: KnowledgeStore, config: KnowledgeCleanerConfig = {}) {
    this.store = store;
    this.valueThreshold = config.valueThreshold ?? 0.1;
    this.capacityLimit = config.capacityLimit ?? 10_000;
    this.gracePeriodDays = config.gracePeriodDays ?? 30;
    this.contradictionFn = config.contradictionFn ?? (() => false);
  }

  /** Execute a full cleanup cycle. */
  runCleanup(): CleanupReport {
    const report: CleanupReport = {
      timestamp: new Date().toISOString(),
      archivedCount: 0,
      deprecatedCount: 0,
      deletedCount: 0,
      contradictionsFound: 0,
      totalScanned: 0,
    };

    const allEntries = this.store.getAll(true);
    report.totalScanned = allEntries.length;

    // Step 1: Hard-delete entries past grace period
    report.deletedCount = this.deleteExpiredArchives(allEntries);

    // Step 2: Archive low-value active entries
    report.archivedCount = this.archiveLowValue();

    // Step 3: Detect contradictions among active entries
    report.contradictionsFound = this.detectContradictions();

    // Step 4: Capacity management
    report.archivedCount += this.enforceCapacity();

    return report;
  }

  private deleteExpiredArchives(entries: KnowledgeEntry[]): number {
    let deleted = 0;
    for (const entry of entries) {
      if (entry.status !== KnowledgeStatus.Archived) continue;
      const daysArchived = (Date.now() - entry.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
      if (daysArchived >= this.gracePeriodDays) {
        this.store.remove(entry.id);
        deleted++;
      }
    }
    return deleted;
  }

  private archiveLowValue(): number {
    let archived = 0;
    const active = this.store.query({ status: KnowledgeStatus.Active });
    for (const entry of active) {
      if (entry.currentValue < this.valueThreshold) {
        entry.archive();
        this.store.add(entry); // persist status change
        archived++;
      }
    }
    return archived;
  }

  private detectContradictions(): number {
    const active = this.store.query({ status: KnowledgeStatus.Active });
    let contradictions = 0;
    const deprecatedIds = new Set<string>();

    for (let i = 0; i < active.length; i++) {
      const entryA = active[i];
      if (deprecatedIds.has(entryA.id)) continue;

      for (let j = i + 1; j < active.length; j++) {
        const entryB = active[j];
        if (deprecatedIds.has(entryB.id)) continue;

        if (this.contradictionFn(entryA.content, entryB.content)) {
          contradictions++;
          if (entryA.confidence >= entryB.confidence) {
            entryB.deprecate();
            this.store.add(entryB);
            deprecatedIds.add(entryB.id);
          } else {
            entryA.deprecate();
            this.store.add(entryA);
            deprecatedIds.add(entryA.id);
            break;
          }
        }
      }
    }

    return contradictions;
  }

  private enforceCapacity(): number {
    const active = this.store.query({ status: KnowledgeStatus.Active });
    if (active.length <= this.capacityLimit) return 0;

    // Sort by value ascending, archive the tail
    active.sort((a, b) => a.currentValue - b.currentValue);
    const toArchive = active.slice(0, active.length - this.capacityLimit);
    for (const entry of toArchive) {
      entry.archive();
      this.store.add(entry);
    }
    return toArchive.length;
  }
}
