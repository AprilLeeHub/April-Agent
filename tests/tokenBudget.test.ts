import { TokenBudget } from '../src/memory/tokenBudget';

describe('TokenBudget', () => {
  it('should have correct default values', () => {
    const budget = new TokenBudget();
    expect(budget.total).toBe(128_000);
    expect(budget.systemPrompt).toBe(2_000);
    expect(budget.available).toBe(126_000);
  });

  it('should compute compression budget', () => {
    const budget = new TokenBudget({ total: 100_000, systemPrompt: 0, compressionRatio: 0.5 });
    expect(budget.compressionBudget).toBe(50_000);
  });

  it('should compute remaining for memory with surplus', () => {
    const budget = new TokenBudget({ total: 100_000, systemPrompt: 0, compressionRatio: 0.4, memoryRatio: 0.1 });
    // Compression used only 20000 out of 40000 budget → surplus of 20000
    expect(budget.remainingForMemory(20_000)).toBe(30_000);
  });

  it('should compute remaining for memory with no surplus', () => {
    const budget = new TokenBudget({ total: 100_000, systemPrompt: 0, compressionRatio: 0.4, memoryRatio: 0.1 });
    expect(budget.remainingForMemory(40_000)).toBe(10_000);
  });

  it('should compute remaining for memory when over budget', () => {
    const budget = new TokenBudget({ total: 100_000, systemPrompt: 0, compressionRatio: 0.4, memoryRatio: 0.1 });
    // Over budget → no surplus added, still get base memory budget
    expect(budget.remainingForMemory(50_000)).toBe(10_000);
  });
});
