"""Tests for KnowledgeCleaner."""

from datetime import datetime, timezone, timedelta

from src.memory.knowledge import KnowledgeEntry, KnowledgeStore, KnowledgeStatus
from src.memory.cleanup import KnowledgeCleaner


class TestKnowledgeCleaner:
    def test_archive_low_value(self) -> None:
        store = KnowledgeStore()
        old_time = datetime.now(timezone.utc) - timedelta(days=100)
        store.add(KnowledgeEntry(
            id="low", content="old fact", confidence=0.1,
            access_count=0, last_accessed=old_time, decay_rate=0.1,
        ))
        store.add(KnowledgeEntry(
            id="high", content="fresh fact", confidence=1.0, access_count=10,
        ))

        cleaner = KnowledgeCleaner(store, value_threshold=0.1)
        report = cleaner.run_cleanup()
        assert report.archived_count >= 1
        assert store.get("low").status == KnowledgeStatus.ARCHIVED
        assert store.get("high").status == KnowledgeStatus.ACTIVE

    def test_hard_delete_after_grace_period(self) -> None:
        store = KnowledgeStore()
        old_time = datetime.now(timezone.utc) - timedelta(days=60)
        entry = KnowledgeEntry(
            id="archived", content="old", status=KnowledgeStatus.ARCHIVED,
            last_accessed=old_time,
        )
        store.add(entry)

        cleaner = KnowledgeCleaner(store, grace_period_days=30)
        report = cleaner.run_cleanup()
        assert report.deleted_count == 1
        assert store.get("archived") is None

    def test_contradiction_detection(self) -> None:
        store = KnowledgeStore()
        store.add(KnowledgeEntry(id="a", content="X is true", confidence=0.9, access_count=10))
        store.add(KnowledgeEntry(id="b", content="X is false", confidence=0.5, access_count=10))

        # Custom contradiction detector
        def detect(a: str, b: str) -> bool:
            return "true" in a and "false" in b

        cleaner = KnowledgeCleaner(store, contradiction_fn=detect)
        report = cleaner.run_cleanup()
        assert report.contradictions_found == 1
        # Lower confidence entry should be deprecated
        assert store.get("b").status == KnowledgeStatus.DEPRECATED
        assert store.get("a").status == KnowledgeStatus.ACTIVE

    def test_capacity_enforcement(self) -> None:
        store = KnowledgeStore()
        for i in range(5):
            store.add(KnowledgeEntry(
                id=f"e{i}", content=f"fact {i}",
                confidence=0.1 * (i + 1), access_count=i,
            ))

        cleaner = KnowledgeCleaner(store, capacity_limit=3)
        report = cleaner.run_cleanup()
        active = store.query(status=KnowledgeStatus.ACTIVE)
        assert len(active) <= 3

    def test_report_summary(self) -> None:
        store = KnowledgeStore()
        cleaner = KnowledgeCleaner(store)
        report = cleaner.run_cleanup()
        summary = report.summary()
        assert "Cleanup Report" in summary
        assert "Scanned" in summary
