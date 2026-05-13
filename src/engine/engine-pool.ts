/**
 * Summary: Per-session engine pooling that acquires inside a tiny critical
 * section, runs outside the lock, and always releases in finally.
 */

import { Observability } from './observability.js';

export class EnginePool<TEngine> {
  private readonly engines = new Map<string, TEngine>();
  private readonly busySessions = new Set<string>();

  constructor(
    private readonly factory: (sessionId: string) => TEngine,
    private readonly observability: Observability,
  ) {}

  async withEngine<TResult>(sessionId: string, turnId: string, task: (engine: TEngine) => Promise<TResult>): Promise<TResult> {
    if (this.busySessions.has(sessionId)) {
      this.observability.blocked(sessionId, turnId, 'engine.acquire', 'Engine is already busy for this session.');
      throw new Error(`Engine for session ${sessionId} is already running.`);
    }

    const engine = this.engines.get(sessionId) ?? this.factory(sessionId);
    this.engines.set(sessionId, engine);
    this.busySessions.add(sessionId);
    this.observability.executed(sessionId, turnId, 'engine.acquire', 'Acquired engine for session.');

    try {
      return await task(engine);
    } finally {
      this.busySessions.delete(sessionId);
      this.observability.executed(sessionId, turnId, 'engine.release', 'Returned engine to pool.');
    }
  }

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }
}