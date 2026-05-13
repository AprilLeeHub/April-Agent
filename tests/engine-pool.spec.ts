import { describe, expect, it } from 'vitest';

import { EnginePool } from '../src/engine/engine-pool.js';
import { Observability } from '../src/engine/observability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('EnginePool', () => {
  it('returns engines in finally so other sessions are not blocked by long work', async () => {
    const observability = new Observability();
    const pool = new EnginePool((sessionId: string) => ({ sessionId }), observability);
    const gate = deferred<void>();

    const slowRun = pool.withEngine('session-a', 'turn-a', async () => {
      await gate.promise;
      return 'slow';
    });

    const fastRun = pool.withEngine('session-b', 'turn-b', async () => 'fast');
    expect(await fastRun).toBe('fast');

    gate.resolve();
    expect(await slowRun).toBe('slow');
    expect(observability.count('engine.acquire', 'executed')).toBe(2);
    expect(observability.count('engine.release', 'executed')).toBe(2);
  });

  it('blocks concurrent reuse of the same session engine', async () => {
    const observability = new Observability();
    const pool = new EnginePool((sessionId: string) => ({ sessionId }), observability);
    const gate = deferred<void>();

    const slowRun = pool.withEngine('session-a', 'turn-a', async () => {
      await gate.promise;
      return 'slow';
    });

    await expect(pool.withEngine('session-a', 'turn-b', async () => 'fast')).rejects.toThrow(/already running/i);
    gate.resolve();
    await slowRun;
  });
});