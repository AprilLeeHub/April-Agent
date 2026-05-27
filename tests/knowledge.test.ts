import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeEntry, KnowledgeStore, KnowledgeSource, KnowledgeStatus } from '../src/memory/knowledge';

describe('KnowledgeEntry', () => {
  it('should have high value when fresh', () => {
    const entry = new KnowledgeEntry({ id: '1', content: 'test', confidence: 1.0, accessCount: 10 });
    expect(entry.currentValue).toBeGreaterThan(0.9);
  });

  it('should decay over time', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const entry = new KnowledgeEntry({
      id: '1', content: 'test', confidence: 1.0,
      accessCount: 10, lastAccessed: oldDate.toISOString(), decayRate: 0.1,
    });
    expect(entry.currentValue).toBeLessThan(0.1);
  });

  it('should track access', () => {
    const entry = new KnowledgeEntry({ id: '1', content: 'test', accessCount: 0 });
    entry.access();
    expect(entry.accessCount).toBe(1);
  });

  it('should serialize and deserialize', () => {
    const entry = new KnowledgeEntry({
      id: 'test_id',
      content: 'hello world',
      source: KnowledgeSource.UserCorrection,
      confidence: 0.9,
      tags: ['tag1'],
      projectId: 'proj1',
    });
    const data = entry.toJSON();
    const restored = new KnowledgeEntry(data);
    expect(restored.id).toBe('test_id');
    expect(restored.content).toBe('hello world');
    expect(restored.source).toBe(KnowledgeSource.UserCorrection);
    expect(restored.confidence).toBe(0.9);
    expect(restored.tags).toEqual(['tag1']);
  });
});

describe('KnowledgeStore', () => {
  it('should add and get', () => {
    const store = new KnowledgeStore();
    store.add(new KnowledgeEntry({ id: 'e1', content: 'fact 1' }));
    expect(store.get('e1')).toBeDefined();
    expect(store.get('e1')!.content).toBe('fact 1');
  });

  it('should query by project', () => {
    const store = new KnowledgeStore();
    store.add(new KnowledgeEntry({ id: '1', content: 'a', projectId: 'p1' }));
    store.add(new KnowledgeEntry({ id: '2', content: 'b', projectId: 'p2' }));
    const results = store.query({ projectId: 'p1' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('should query by tags', () => {
    const store = new KnowledgeStore();
    store.add(new KnowledgeEntry({ id: '1', content: 'a', tags: ['python'] }));
    store.add(new KnowledgeEntry({ id: '2', content: 'b', tags: ['rust'] }));
    const results = store.query({ tags: ['python'] });
    expect(results).toHaveLength(1);
  });

  it('should query with minValue filter', () => {
    const store = new KnowledgeStore();
    store.add(new KnowledgeEntry({ id: '1', content: 'high', confidence: 1.0, accessCount: 10 }));
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    store.add(new KnowledgeEntry({ id: '2', content: 'low', confidence: 0.1, accessCount: 0, lastAccessed: oldDate.toISOString() }));
    const results = store.query({ minValue: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('should persist and reload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'april-test-'));
    const filePath = path.join(tmpDir, 'knowledge.json');
    try {
      const store = new KnowledgeStore(filePath);
      store.add(new KnowledgeEntry({ id: 'e1', content: 'persisted fact' }));

      const store2 = new KnowledgeStore(filePath);
      expect(store2.get('e1')).toBeDefined();
      expect(store2.get('e1')!.content).toBe('persisted fact');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
