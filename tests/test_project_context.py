"""Tests for ProjectContextStore."""

import json
import tempfile
from pathlib import Path

from src.memory.project_context import ProjectContext, ProjectContextStore


class TestProjectContext:
    def test_to_context_string(self) -> None:
        ctx = ProjectContext(
            project_id="test",
            name="TestProject",
            tools=["retry", "agent"],
            modules=["src.retry", "src.agent"],
        )
        result = ctx.to_context_string()
        assert "TestProject" in result
        assert "retry" in result
        assert "agent" in result


class TestProjectContextStore:
    def test_register_and_get(self) -> None:
        store = ProjectContextStore()
        ctx = ProjectContext(project_id="p1", name="Project1", tools=["tool_a"])
        store.register(ctx)
        retrieved = store.get("p1")
        assert retrieved is not None
        assert retrieved.name == "Project1"
        assert retrieved.tools == ["tool_a"]

    def test_get_missing(self) -> None:
        store = ProjectContextStore()
        assert store.get("nonexistent") is None

    def test_remove(self) -> None:
        store = ProjectContextStore()
        ctx = ProjectContext(project_id="p1", name="P1")
        store.register(ctx)
        assert store.remove("p1") is True
        assert store.get("p1") is None
        assert store.remove("p1") is False

    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "projects.json"
            store = ProjectContextStore(storage_path=path)
            store.register(ProjectContext(project_id="p1", name="Persisted", tools=["t1"]))

            # Reload from file
            store2 = ProjectContextStore(storage_path=path)
            ctx = store2.get("p1")
            assert ctx is not None
            assert ctx.name == "Persisted"
            assert ctx.tools == ["t1"]

    def test_list_projects(self) -> None:
        store = ProjectContextStore()
        store.register(ProjectContext(project_id="a", name="A"))
        store.register(ProjectContext(project_id="b", name="B"))
        assert sorted(store.list_projects()) == ["a", "b"]
