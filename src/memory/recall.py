"""Memory recall module - P2 priority.

Implements the session-start recall strategy:
- L0 (Project Context): Always recalled
- L1 (User Preferences): Always recalled
- L2 (Task Patterns): Conditional, similarity-based
- L3 (Deep Knowledge): Only on explicit trigger
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .project_context import ProjectContext, ProjectContextStore
from .knowledge import KnowledgeEntry, KnowledgeStore, KnowledgeStatus
from .token_budget import TokenBudget
from .compressor import ContextCompressor, Message


RECALL_THRESHOLD: float = 0.3


@dataclass
class UserPreferences:
    """L1 layer: user-level preferences."""

    user_id: str
    language: str = "zh"
    response_style: str = "detailed"
    custom: dict[str, Any] = field(default_factory=dict)

    def to_context_string(self) -> str:
        """Render as context string for prompt injection."""
        parts = [f"User preferences (user={self.user_id}):"]
        parts.append(f"  Language: {self.language}")
        parts.append(f"  Style: {self.response_style}")
        for k, v in self.custom.items():
            parts.append(f"  {k}: {v}")
        return "\n".join(parts)


@dataclass
class RecalledContext:
    """Container for all recalled memory at session start."""

    project_context: ProjectContext | None = None
    user_preferences: UserPreferences | None = None
    task_patterns: list[KnowledgeEntry] = field(default_factory=list)
    total_tokens_used: int = 0

    def to_messages(self) -> list[Message]:
        """Convert recalled context into messages for prompt injection."""
        messages: list[Message] = []
        if self.project_context:
            content = self.project_context.to_context_string()
            messages.append(Message(
                role="system",
                content=f"[Project Context]\n{content}",
                token_count=len(content) // 4,
                importance=1.0,
            ))
        if self.user_preferences:
            content = self.user_preferences.to_context_string()
            messages.append(Message(
                role="system",
                content=f"[User Preferences]\n{content}",
                token_count=len(content) // 4,
                importance=0.9,
            ))
        for entry in self.task_patterns:
            messages.append(Message(
                role="system",
                content=f"[Recalled Knowledge]\n{entry.content}",
                token_count=len(entry.content) // 4,
                importance=entry.current_value,
            ))
        return messages


class MemoryRecaller:
    """Orchestrates memory recall at session start.

    Follows the priority order:
    1. Context compression (handled externally, before recall)
    2. L0 project context - always
    3. L1 user preferences - always
    4. L2 task patterns - conditional (similarity-based)
    5. L3 deep knowledge - never at startup
    """

    def __init__(
        self,
        project_store: ProjectContextStore,
        knowledge_store: KnowledgeStore,
        token_budget: TokenBudget,
        similarity_fn: Callable[[str, str], float] | None = None,
    ) -> None:
        self.project_store = project_store
        self.knowledge_store = knowledge_store
        self.token_budget = token_budget
        self._similarity_fn = similarity_fn or self._default_similarity

    @staticmethod
    def _default_similarity(query: str, content: str) -> float:
        """Simple keyword overlap similarity (placeholder for embeddings)."""
        if not query or not content:
            return 0.0
        query_words = set(query.lower().split())
        content_words = set(content.lower().split())
        if not query_words:
            return 0.0
        overlap = query_words.intersection(content_words)
        return len(overlap) / len(query_words)

    def recall(
        self,
        project_id: str,
        user_prefs: UserPreferences | None = None,
        first_message: str | None = None,
        compressed_tokens: int = 0,
        top_k: int = 3,
    ) -> RecalledContext:
        """Execute session-start memory recall.

        Args:
            project_id: Current project identifier.
            user_prefs: User preferences (L1).
            first_message: User's first message for similarity matching.
            compressed_tokens: Tokens already used by compression.
            top_k: Max task patterns to recall.

        Returns:
            RecalledContext with all recalled information.
        """
        available_tokens = self.token_budget.remaining_for_memory(compressed_tokens)
        tokens_used = 0
        result = RecalledContext()

        # L0: Always recall project context
        project_ctx = self.project_store.get(project_id)
        if project_ctx:
            ctx_tokens = len(project_ctx.to_context_string()) // 4
            if tokens_used + ctx_tokens <= available_tokens:
                result.project_context = project_ctx
                tokens_used += ctx_tokens

        # L1: Always recall user preferences
        if user_prefs:
            pref_tokens = len(user_prefs.to_context_string()) // 4
            if tokens_used + pref_tokens <= available_tokens:
                result.user_preferences = user_prefs
                tokens_used += pref_tokens

        # L2: Conditional recall of task patterns
        if first_message:
            candidates = self.knowledge_store.query(
                project_id=project_id,
                status=KnowledgeStatus.ACTIVE,
                min_value=0.1,
            )
            # Score by similarity and value
            scored = []
            for entry in candidates:
                sim = self._similarity_fn(first_message, entry.content)
                if sim >= RECALL_THRESHOLD:
                    scored.append((sim * entry.current_value, entry))
            scored.sort(key=lambda x: x[0], reverse=True)

            for _, entry in scored[:top_k]:
                entry_tokens = len(entry.content) // 4
                if tokens_used + entry_tokens > available_tokens:
                    break
                entry.access()
                result.task_patterns.append(entry)
                tokens_used += entry_tokens

        # L3: Not recalled at startup (explicit trigger only)

        result.total_tokens_used = tokens_used
        return result
