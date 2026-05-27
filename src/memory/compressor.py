"""Context compression module - P0 priority.

Compresses conversation history to fit within token budget while
preserving key information needed for task continuity.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Message:
    """A single conversation message."""

    role: str
    content: str
    token_count: int = 0
    importance: float = 1.0


@dataclass
class CompressionResult:
    """Result of context compression."""

    messages: list[Message]
    total_tokens: int
    original_tokens: int
    compression_ratio: float

    @property
    def tokens_saved(self) -> int:
        return self.original_tokens - self.total_tokens


class ContextCompressor(abc.ABC):
    """Abstract base class for context compression strategies.

    Context compression is the highest priority operation (P0).
    It must execute before any memory recall to ensure the current
    task stays on track within the token budget.
    """

    @abc.abstractmethod
    def compress(
        self, messages: list[Message], max_tokens: int
    ) -> CompressionResult:
        """Compress messages to fit within max_tokens.

        Args:
            messages: Full conversation history.
            max_tokens: Maximum allowed tokens after compression.

        Returns:
            CompressionResult with compressed messages.
        """
        ...

    @staticmethod
    def estimate_tokens(text: str) -> int:
        """Rough token estimation (4 chars ≈ 1 token)."""
        return len(text) // 4


class SlidingWindowCompressor(ContextCompressor):
    """Compression via sliding window with importance-based retention.

    Strategy:
    1. Always keep the system message and latest N messages.
    2. For older messages, retain only those above importance threshold.
    3. Summarize dropped messages into a single condensed message.
    """

    def __init__(
        self,
        recent_window: int = 5,
        importance_threshold: float = 0.5,
    ) -> None:
        self.recent_window = recent_window
        self.importance_threshold = importance_threshold

    def compress(
        self, messages: list[Message], max_tokens: int
    ) -> CompressionResult:
        if not messages:
            return CompressionResult(
                messages=[], total_tokens=0, original_tokens=0, compression_ratio=1.0
            )

        original_tokens = sum(m.token_count or self.estimate_tokens(m.content) for m in messages)

        # If already within budget, no compression needed
        if original_tokens <= max_tokens:
            return CompressionResult(
                messages=list(messages),
                total_tokens=original_tokens,
                original_tokens=original_tokens,
                compression_ratio=1.0,
            )

        # Split: system messages + recent window are protected
        system_msgs = [m for m in messages if m.role == "system"]
        non_system = [m for m in messages if m.role != "system"]

        recent = non_system[-self.recent_window :] if len(non_system) > self.recent_window else non_system
        older = non_system[: -self.recent_window] if len(non_system) > self.recent_window else []

        # Filter older messages by importance
        important_older = [m for m in older if m.importance >= self.importance_threshold]

        # Build summary of dropped messages
        dropped = [m for m in older if m.importance < self.importance_threshold]
        summary_parts: list[str] = []
        if dropped:
            summary_content = f"[Compressed {len(dropped)} earlier messages]"
            summary_msg = Message(
                role="system",
                content=summary_content,
                token_count=self.estimate_tokens(summary_content),
                importance=0.3,
            )
            summary_parts = [summary_msg]

        # Assemble final messages
        result_msgs = system_msgs + summary_parts + important_older + recent

        # Trim from important_older if still over budget
        total = sum(m.token_count or self.estimate_tokens(m.content) for m in result_msgs)
        while total > max_tokens and important_older:
            removed = important_older.pop(0)
            result_msgs = system_msgs + summary_parts + important_older + recent
            total = sum(m.token_count or self.estimate_tokens(m.content) for m in result_msgs)

        final_tokens = sum(m.token_count or self.estimate_tokens(m.content) for m in result_msgs)
        ratio = final_tokens / original_tokens if original_tokens > 0 else 1.0

        return CompressionResult(
            messages=result_msgs,
            total_tokens=final_tokens,
            original_tokens=original_tokens,
            compression_ratio=ratio,
        )
