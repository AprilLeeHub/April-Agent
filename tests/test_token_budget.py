"""Tests for TokenBudget."""

from src.memory.token_budget import TokenBudget


class TestTokenBudget:
    def test_default_values(self) -> None:
        budget = TokenBudget()
        assert budget.total == 128_000
        assert budget.system_prompt == 2_000
        assert budget.available == 126_000

    def test_compression_budget(self) -> None:
        budget = TokenBudget(total=100_000, system_prompt=0, compression_ratio=0.5)
        assert budget.compression_budget == 50_000

    def test_remaining_for_memory_surplus(self) -> None:
        budget = TokenBudget(total=100_000, system_prompt=0, compression_ratio=0.4, memory_ratio=0.1)
        # Compression used only 20000 out of 40000 budget → surplus of 20000
        remaining = budget.remaining_for_memory(compressed_tokens=20_000)
        # memory_budget = 10000 + surplus 20000 = 30000
        assert remaining == 30_000

    def test_remaining_for_memory_no_surplus(self) -> None:
        budget = TokenBudget(total=100_000, system_prompt=0, compression_ratio=0.4, memory_ratio=0.1)
        # Compression used exactly its budget
        remaining = budget.remaining_for_memory(compressed_tokens=40_000)
        assert remaining == 10_000

    def test_remaining_for_memory_over_budget(self) -> None:
        budget = TokenBudget(total=100_000, system_prompt=0, compression_ratio=0.4, memory_ratio=0.1)
        # Compression exceeded budget → no surplus added
        remaining = budget.remaining_for_memory(compressed_tokens=50_000)
        assert remaining == 10_000
