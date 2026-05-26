import { describe, expect, it } from 'vitest';

import { buildPiTuiRuntimeError, parseNodeVersion, supportsPiTuiNode } from '../src/cli/pi-tui-support.js';

describe('pi-tui support helpers', () => {
  it('parses Node versions with and without a leading v', () => {
    expect(parseNodeVersion('v22.19.0')).toEqual({ major: 22, minor: 19, patch: 0 });
    expect(parseNodeVersion('20.19.6')).toEqual({ major: 20, minor: 19, patch: 6 });
  });

  it('accepts only Node 22.19.0 and newer for pi-tui', () => {
    expect(supportsPiTuiNode('20.19.6')).toBe(false);
    expect(supportsPiTuiNode('22.18.9')).toBe(false);
    expect(supportsPiTuiNode('22.19.0')).toBe(true);
    expect(supportsPiTuiNode('24.1.0')).toBe(true);
  });

  it('builds an actionable runtime error message for unsupported runtimes', () => {
    const errorMessage = buildPiTuiRuntimeError('20.19.6');

    expect(errorMessage).toContain('Node >= 22.19.0');
    expect(errorMessage).toContain('demo:cli');
    expect(errorMessage).toContain('20.19.6');
  });
});