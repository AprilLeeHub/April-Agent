import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionCache, CrossSessionCache } from '../src/memory/cache';

describe('SessionCache', () => {
  it('should put and get', () => {
    const cache = new SessionCache();
    cache.put('q1', 'answer1');
    expect(cache.get('q1')).toBe('answer1');
  });

  it('should return undefined on miss', () => {
    const cache = new SessionCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('should evict LRU', () => {
    const cache = new SessionCache(2);
    cache.put('a', '1');
    cache.put('b', '2');
    cache.put('c', '3'); // should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('should invalidate', () => {
    const cache = new SessionCache();
    cache.put('k', 'v');
    expect(cache.invalidate('k')).toBe(true);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.invalidate('k')).toBe(false);
  });

  it('should clear', () => {
    const cache = new SessionCache();
    cache.put('a', '1');
    cache.put('b', '2');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('CrossSessionCache', () => {
  it('should put and get', () => {
    const cache = new CrossSessionCache();
    cache.put('user1', 'proj1', 'what tools?', 'retry, agent');
    expect(cache.get('user1', 'proj1', 'what tools?')).toBe('retry, agent');
  });

  it('should return undefined on miss', () => {
    const cache = new CrossSessionCache();
    expect(cache.get('u', 'p', 'q')).toBeUndefined();
  });

  it('should expire entries based on TTL', async () => {
    const cache = new CrossSessionCache({ defaultTtl: 0.01 }); // 10ms
    cache.put('u', 'p', 'q', 'val');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cache.get('u', 'p', 'q')).toBeUndefined();
  });

  it('should invalidate by project', () => {
    const cache = new CrossSessionCache();
    cache.put('u1', 'proj1', 'q1', 'v1');
    cache.put('u1', 'proj1', 'q2', 'v2');
    cache.put('u1', 'proj2', 'q1', 'v3');
    const removed = cache.invalidateProject('proj1');
    expect(removed).toBe(2);
    expect(cache.get('u1', 'proj1', 'q1')).toBeUndefined();
    expect(cache.get('u1', 'proj2', 'q1')).toBe('v3');
  });

  it('should persist and reload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'april-test-'));
    const filePath = path.join(tmpDir, 'cache.json');
    try {
      const cache = new CrossSessionCache({ storagePath: filePath });
      cache.put('u', 'p', 'q', 'v');

      const cache2 = new CrossSessionCache({ storagePath: filePath });
      expect(cache2.get('u', 'p', 'q')).toBe('v');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('should evict when over capacity', () => {
    const cache = new CrossSessionCache({ maxSize: 2 });
    cache.put('u', 'p', 'q1', 'v1');
    cache.put('u', 'p', 'q2', 'v2');
    cache.put('u', 'p', 'q3', 'v3');
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
