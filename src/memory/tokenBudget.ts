/**
 * Token budget management for LLM context window allocation.
 *
 * Ensures that context compression, memory recall, and active task
 * all stay within the model's context window limits.
 */

export interface TokenBudgetConfig {
  total?: number;
  systemPrompt?: number;
  compressionRatio?: number;
  memoryRatio?: number;
  taskRatio?: number;
  bufferRatio?: number;
}

export class TokenBudget {
  readonly total: number;
  readonly systemPrompt: number;
  readonly compressionRatio: number;
  readonly memoryRatio: number;
  readonly taskRatio: number;
  readonly bufferRatio: number;

  constructor(config: TokenBudgetConfig = {}) {
    this.total = config.total ?? 128_000;
    this.systemPrompt = config.systemPrompt ?? 2_000;
    this.compressionRatio = config.compressionRatio ?? 0.4;
    this.memoryRatio = config.memoryRatio ?? 0.1;
    this.taskRatio = config.taskRatio ?? 0.4;
    this.bufferRatio = config.bufferRatio ?? 0.1;
  }

  /** Total tokens available after system prompt. */
  get available(): number {
    return this.total - this.systemPrompt;
  }

  /** Max tokens allocated for compressed history. */
  get compressionBudget(): number {
    return Math.floor(this.available * this.compressionRatio);
  }

  /** Max tokens allocated for memory recall. */
  get memoryBudget(): number {
    return Math.floor(this.available * this.memoryRatio);
  }

  /** Max tokens allocated for active task context. */
  get taskBudget(): number {
    return Math.floor(this.available * this.taskRatio);
  }

  /** Remaining buffer for unexpected growth. */
  get bufferBudget(): number {
    return Math.floor(this.available * this.bufferRatio);
  }

  /**
   * Calculate remaining budget for memory after compression.
   * If compression used less than its budget, the surplus goes to memory.
   */
  remainingForMemory(compressedTokens: number): number {
    const compressionSurplus = this.compressionBudget - compressedTokens;
    const availableForMemory = this.memoryBudget + Math.max(0, compressionSurplus);
    return Math.max(0, availableForMemory);
  }
}
