"""Tests for ContextCompressor."""

from src.memory.compressor import Message, SlidingWindowCompressor


class TestSlidingWindowCompressor:
    def test_no_compression_needed(self) -> None:
        compressor = SlidingWindowCompressor()
        messages = [Message(role="user", content="hello", token_count=5)]
        result = compressor.compress(messages, max_tokens=100)
        assert result.total_tokens == 5
        assert result.compression_ratio == 1.0
        assert len(result.messages) == 1

    def test_empty_messages(self) -> None:
        compressor = SlidingWindowCompressor()
        result = compressor.compress([], max_tokens=100)
        assert result.total_tokens == 0
        assert len(result.messages) == 0

    def test_compression_drops_low_importance(self) -> None:
        compressor = SlidingWindowCompressor(recent_window=2, importance_threshold=0.5)
        messages = [
            Message(role="user", content="old low importance", token_count=10, importance=0.2),
            Message(role="assistant", content="old response", token_count=10, importance=0.2),
            Message(role="user", content="important old", token_count=10, importance=0.8),
            Message(role="user", content="recent 1", token_count=10),
            Message(role="assistant", content="recent 2", token_count=10),
        ]
        result = compressor.compress(messages, max_tokens=35)
        # Should keep: important_old + recent_1 + recent_2 + summary
        assert result.total_tokens < 50
        # Low importance messages should be summarized
        contents = [m.content for m in result.messages]
        assert "old low importance" not in contents

    def test_system_messages_preserved(self) -> None:
        compressor = SlidingWindowCompressor(recent_window=1)
        messages = [
            Message(role="system", content="system prompt", token_count=5),
            Message(role="user", content="old msg", token_count=100, importance=0.1),
            Message(role="user", content="latest", token_count=5),
        ]
        result = compressor.compress(messages, max_tokens=20)
        roles = [m.role for m in result.messages]
        assert "system" in roles
