import { KnowledgeEntry, KnowledgeStore, KnowledgeStatus } from '../src/memory/knowledge';
import { KnowledgeCleaner, cleanupReportSummary } from '../src/memory/cleanup';

describe('KnowledgeCleaner', () => {
  it('should archive low-value entries', () => {
    const store = new KnowledgeStore();
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    store.add(new KnowledgeEntry({
      id: 'low', content: 'old fact', confidence: 0.1,
      accessCount: 0, lastAccessed: oldDate.toISOString(), decayRate: 0.1,
    }));
    store.add(new KnowledgeEntry({
      id: 'high', content: 'fresh fact', confidence: 1.0, accessCount: 10,
    }));

    const cleaner = new KnowledgeCleaner(store, { valueThreshold: 0.1 });
    const report = cleaner.runCleanup();
    expect(report.archivedCount).toBeGreaterThanOrEqual(1);
    expect(store.get('low')!.status).toBe(KnowledgeStatus.Archived);
    expect(store.get('high')!.status).toBe(KnowledgeStatus.Active);
  });

  it('should hard-delete after grace period', () => {
    const store = new KnowledgeStore();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    store.add(new KnowledgeEntry({
      id: 'archived', content: 'old',
      status: KnowledgeStatus.Archived,
      lastAccessed: oldDate.toISOString(),
    }));

    const cleaner = new KnowledgeCleaner(store, { gracePeriodDays: 30 });
    const report = cleaner.runCleanup();
    expect(report.deletedCount).toBe(1);
    expect(store.get('archived')).toBeUndefined();
  });

  it('should detect contradictions', () => {
    const store = new KnowledgeStore();
    store.add(new KnowledgeEntry({ id: 'a', content: 'X is true', confidence: 0.9, accessCount: 10 }));
    store.add(new KnowledgeEntry({ id: 'b', content: 'X is false', confidence: 0.5, accessCount: 10 }));

    const contradictionFn = (a: string, b: string) => a.includes('true') && b.includes('false');
    const cleaner = new KnowledgeCleaner(store, { contradictionFn });
    const report = cleaner.runCleanup();
    expect(report.contradictionsFound).toBe(1);
    expect(store.get('b')!.status).toBe(KnowledgeStatus.Deprecated);
    expect(store.get('a')!.status).toBe(KnowledgeStatus.Active);
  });

  it('should enforce capacity', () => {
    const store = new KnowledgeStore();
    for (let i = 0; i < 5; i++) {
      store.add(new KnowledgeEntry({
        id: `e${i}`, content: `fact ${i}`,
        confidence: 0.1 * (i + 1), accessCount: i,
      }));
    }

    const cleaner = new KnowledgeCleaner(store, { capacityLimit: 3 });
    const report = cleaner.runCleanup();
    const active = store.query({ status: KnowledgeStatus.Active });
    expect(active.length).toBeLessThanOrEqual(3);
  });

  it('should generate report summary', () => {
    const store = new KnowledgeStore();
    const cleaner = new KnowledgeCleaner(store);
    const report = cleaner.runCleanup();
    const summary = cleanupReportSummary(report);
    expect(summary).toContain('Cleanup Report');
    expect(summary).toContain('Scanned');
  });
});
