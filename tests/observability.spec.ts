import { describe, expect, it } from 'vitest';

import { Observability } from '../src/engine/observability.js';

describe('Observability', () => {
  it('records all four decision states', () => {
    const observability = new Observability();
    observability.executed('s1', 't1', 'llm.request', 'ran');
    observability.skipped('s1', 't1', 'compression.summary', 'skipped');
    observability.blocked('s1', 't1', 'loop.guard', 'blocked');
    observability.error('s1', 't1', 'tool.execute', 'errored');

    expect(observability.count('llm.request', 'executed')).toBe(1);
    expect(observability.count('compression.summary', 'skipped')).toBe(1);
    expect(observability.count('loop.guard', 'blocked')).toBe(1);
    expect(observability.count('tool.execute', 'error')).toBe(1);
  });

  it('fails when an expected decision event never appears', () => {
    const observability = new Observability();
    expect(() => observability.assertDecisionRecorded('engine.release')).toThrow(/none was recorded/i);
  });
});