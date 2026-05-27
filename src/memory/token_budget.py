"""Token budget management for LLM context window allocation."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TokenBudget:
    """Manages token allocation across different context components.

    Ensures that context compression, memory recall, and active task
    all stay within the model's context window limits.
    """

    total: int = 128_000
    system_prompt: int = 2_000
    compression_ratio: float = 0.4
    memory_ratio: float = 0.1
    task_ratio: float = 0.4
    buffer_ratio: float = 0.1

    @property
    def available(self) -> int:
        """Total tokens available after system prompt."""
        return self.total - self.system_prompt

    @property
    def compression_budget(self) -> int:
        """Max tokens allocated for compressed history."""
        return int(self.available * self.compression_ratio)

    @property
    def memory_budget(self) -> int:
        """Max tokens allocated for memory recall."""
        return int(self.available * self.memory_ratio)

    @property
    def task_budget(self) -> int:
        """Max tokens allocated for active task context."""
        return int(self.available * self.task_ratio)

    @property
    def buffer_budget(self) -> int:
        """Remaining buffer for unexpected growth."""
        return int(self.available * self.buffer_ratio)

    def remaining_for_memory(self, compressed_tokens: int) -> int:
        """Calculate remaining budget for memory after compression.

        If compression used less than its budget, the surplus goes to memory.
        If compression exceeded its budget, memory budget is reduced.
        """
        compression_surplus = self.compression_budget - compressed_tokens
        available_for_memory = self.memory_budget + max(0, compression_surplus)
        return max(0, available_for_memory)
