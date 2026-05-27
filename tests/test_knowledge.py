"""Tests for KnowledgeEntry and KnowledgeStore."""

import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

from src.memory.knowledge import (
    KnowledgeEntry,
    KnowledgeSource,
    KnowledgeStatus,
    KnowledgeStore,
)


class TestKnowledgeEntry:
    def test_current_value_fresh(self) -> None:
        entry = KnowledgeEntry(id="1", content="test", confidence=1.0, access_count=10)
        # Fresh entry with max confidence and accesses should have high value
        assert entry.current_value > 0.9

    def test_current_value_decays(self) -> None:
        old_time = datetime.now(timezone.utc) - timedelta(days=30)
        entry = KnowledgeEntry(
            id="1", content="test", confidence=1.0,
            access_count=10, last_accessed=old_time, decay_rate=0.1,
        )
        # 30 days with 0.1 decay → e^(-3) ≈ 0.05
        assert entry.current_value < 0.1

    def test_access_updates(self) -> None:
        entry = KnowledgeEntry(id="1", content="test", access_count=0)
        entry.access()
        assert entry.access_count == 1

    def test_serialization_roundtrip(self) -> None:
        entry = KnowledgeEntry(
            id="test_id",
            content="hello world",
            source=KnowledgeSource.USER_CORRECTION,
            confidence=0.9,
            tags=["tag1"],
            project_id="proj1",
        )
        data = entry.to_dict()
        restored = KnowledgeEntry.from_dict(data)
        assert restored.id == "test_id"
        assert restored.content == "hello world"
        assert restored.source == KnowledgeSource.USER_CORRECTION
        assert restored.confidence == 0.9
        assert restored.tags == ["tag1"]


class TestKnowledgeStore:
    def test_add_and_get(self) -> None:
        store = KnowledgeStore()
        entry = KnowledgeEntry(id="e1", content="fact 1")
        store.add(entry)
        assert store.get("e1") is not None
        assert store.get("e1").content == "fact 1"

    def test_query_by_project(self) -> None:
        store = KnowledgeStore()
        store.add(KnowledgeEntry(id="1", content="a", project_id="p1"))
        store.add(KnowledgeEntry(id="2", content="b", project_id="p2"))
        results = store.query(project_id="p1")
        assert len(results) == 1
        assert results[0].id == "1"

    def test_query_by_tags(self) -> None:
        store = KnowledgeStore()
        store.add(KnowledgeEntry(id="1", content="a", tags=["python"]))
        store.add(KnowledgeEntry(id="2", content="b", tags=["rust"]))
        results = store.query(tags=["python"])
        assert len(results) == 1

    def test_query_min_value(self) -> None:
        store = KnowledgeStore()
        store.add(KnowledgeEntry(id="1", content="high", confidence=1.0, access_count=10))
        old_time = datetime.now(timezone.utc) - timedelta(days=100)
        store.add(KnowledgeEntry(id="2", content="low", confidence=0.1, access_count=0, last_accessed=old_time))
        results = store.query(min_value=0.5)
        assert len(results) == 1
        assert results[0].id == "1"

    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "knowledge.json"
            store = KnowledgeStore(storage_path=path)
            store.add(KnowledgeEntry(id="e1", content="persisted fact"))

            store2 = KnowledgeStore(storage_path=path)
            assert store2.get("e1") is not None
            assert store2.get("e1").content == "persisted fact"
