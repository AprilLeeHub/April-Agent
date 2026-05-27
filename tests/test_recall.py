"""Tests for MemoryRecaller."""

from src.memory.recall import MemoryRecaller, RecalledContext, UserPreferences
from src.memory.project_context import ProjectContext, ProjectContextStore
from src.memory.knowledge import KnowledgeEntry, KnowledgeStore
from src.memory.token_budget import TokenBudget


class TestMemoryRecaller:
    def _setup(self) -> tuple[ProjectContextStore, KnowledgeStore, TokenBudget]:
        project_store = ProjectContextStore()
        project_store.register(ProjectContext(
            project_id="proj1",
            name="TestProject",
            tools=["retry", "agent"],
            modules=["src.retry", "src.agent"],
        ))
        knowledge_store = KnowledgeStore()
        knowledge_store.add(KnowledgeEntry(
            id="k1",
            content="retry module handles exponential backoff",
            project_id="proj1",
            confidence=0.9,
            access_count=5,
        ))
        knowledge_store.add(KnowledgeEntry(
            id="k2",
            content="agent module uses ReAct pattern",
            project_id="proj1",
            confidence=0.8,
            access_count=3,
        ))
        budget = TokenBudget(total=10_000, system_prompt=0)
        return project_store, knowledge_store, budget

    def test_recall_project_context(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        result = recaller.recall(project_id="proj1")
        assert result.project_context is not None
        assert result.project_context.name == "TestProject"

    def test_recall_user_preferences(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        prefs = UserPreferences(user_id="u1", language="en")
        result = recaller.recall(project_id="proj1", user_prefs=prefs)
        assert result.user_preferences is not None
        assert result.user_preferences.language == "en"

    def test_recall_task_patterns_with_similarity(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        result = recaller.recall(
            project_id="proj1",
            first_message="tell me about retry and backoff",
        )
        # Should recall the retry knowledge entry
        assert len(result.task_patterns) >= 1
        contents = [e.content for e in result.task_patterns]
        assert any("retry" in c for c in contents)

    def test_recall_respects_token_budget(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        # Very tight budget
        budget = TokenBudget(total=200, system_prompt=0, memory_ratio=0.5)
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        result = recaller.recall(project_id="proj1", first_message="retry backoff agent")
        # Should not exceed budget
        assert result.total_tokens_used <= budget.remaining_for_memory(0)

    def test_recall_missing_project(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        result = recaller.recall(project_id="nonexistent")
        assert result.project_context is None

    def test_to_messages(self) -> None:
        project_store, knowledge_store, budget = self._setup()
        recaller = MemoryRecaller(project_store, knowledge_store, budget)
        prefs = UserPreferences(user_id="u1")
        result = recaller.recall(project_id="proj1", user_prefs=prefs)
        messages = result.to_messages()
        assert len(messages) >= 2  # project + preferences
        assert all(m.role == "system" for m in messages)
