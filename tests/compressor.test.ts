import { SlidingWindowCompressor, Message } from '../src/memory/compressor';

describe('SlidingWindowCompressor', () => {
  it('should not compress when within budget', () => {
    const compressor = new SlidingWindowCompressor();
    const messages: Message[] = [{ role: 'user', content: 'hello', tokenCount: 5 }];
    const result = compressor.compress(messages, 100);
    expect(result.totalTokens).toBe(5);
    expect(result.compressionRatio).toBe(1.0);
    expect(result.messages).toHaveLength(1);
  });

  it('should handle empty messages', () => {
    const compressor = new SlidingWindowCompressor();
    const result = compressor.compress([], 100);
    expect(result.totalTokens).toBe(0);
    expect(result.messages).toHaveLength(0);
  });

  it('should drop low importance messages', () => {
    const compressor = new SlidingWindowCompressor({ recentWindow: 2, importanceThreshold: 0.5 });
    const messages: Message[] = [
      { role: 'user', content: 'old low importance', tokenCount: 10, importance: 0.2 },
      { role: 'assistant', content: 'old response', tokenCount: 10, importance: 0.2 },
      { role: 'user', content: 'important old', tokenCount: 10, importance: 0.8 },
      { role: 'user', content: 'recent 1', tokenCount: 10 },
      { role: 'assistant', content: 'recent 2', tokenCount: 10 },
    ];
    const result = compressor.compress(messages, 35);
    const contents = result.messages.map(m => m.content);
    expect(contents).not.toContain('old low importance');
  });

  it('should preserve system messages', () => {
    const compressor = new SlidingWindowCompressor({ recentWindow: 1 });
    const messages: Message[] = [
      { role: 'system', content: 'system prompt', tokenCount: 5 },
      { role: 'user', content: 'old msg', tokenCount: 100, importance: 0.1 },
      { role: 'user', content: 'latest', tokenCount: 5 },
    ];
    const result = compressor.compress(messages, 20);
    const roles = result.messages.map(m => m.role);
    expect(roles).toContain('system');
  });
});
