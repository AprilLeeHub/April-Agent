"""Knowledge cleanup module - P3 priority.

Implements periodic knowledge maintenance:
- Value-based decay and archival
- Contradiction detection
- Capacity management
- Source validity checking
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from .knowledge import KnowledgeEntry, KnowledgeStore, KnowledgeStatus


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class CleanupReport:
    """Report generated after a cleanup run."""

    timestamp: datetime = field(default_factory=_now)
    archived_count: int = 0
    deprecated_count: int = 0
    deleted_count: int = 0
    contradictions_found: int = 0
    total_scanned: int = 0

    @property
    def total_actions(self) -> int:
        return self.archived_count + self.deprecated_count + self.deleted_count

    def summary(self) -> str:
        """Human-readable summary."""
        return (
            f"Cleanup Report ({self.timestamp.isoformat()}):\n"
            f"  Scanned: {self.total_scanned}\n"
            f"  Archived: {self.archived_count}\n"
            f"  Deprecated: {self.deprecated_count}\n"
            f"  Deleted: {self.deleted_count}\n"
            f"  Contradictions: {self.contradictions_found}"
        )


class KnowledgeCleaner:
    """Manages knowledge lifecycle and cleanup.

    Strategies:
    1. Auto-decay: Archive entries with current_value below threshold
    2. Contradiction detection: Detect conflicting entries
    3. Capacity management: Archive lowest-value entries when over limit
    4. Grace period: Archived entries are hard-deleted after grace period
    """

    def __init__(
        self,
        store: KnowledgeStore,
        value_threshold: float = 0.1,
        capacity_limit: int = 10_000,
        grace_period_days: int = 30,
        contradiction_fn: Callable[[str, str], bool] | None = None,
    ) -> None:
        self.store = store
        self.value_threshold = value_threshold
        self.capacity_limit = capacity_limit
        self.grace_period_days = grace_period_days
        self._contradiction_fn = contradiction_fn or self._default_contradiction

    @staticmethod
    def _default_contradiction(a: str, b: str) -> bool:
        """Simple contradiction detection placeholder.

        In production, this would use semantic similarity + negation detection.
        """
        return False

    def run_cleanup(self) -> CleanupReport:
        """Execute a full cleanup cycle.

        Returns:
            CleanupReport with statistics on actions taken.
        """
        report = CleanupReport()
        all_entries = self.store.get_all(include_inactive=True)
        report.total_scanned = len(all_entries)

        # Step 1: Hard-delete entries past grace period
        report.deleted_count = self._delete_expired_archives(all_entries)

        # Step 2: Archive low-value active entries
        report.archived_count = self._archive_low_value()

        # Step 3: Detect contradictions among active entries
        report.contradictions_found = self._detect_contradictions()

        # Step 4: Capacity management
        report.archived_count += self._enforce_capacity()

        return report

    def _delete_expired_archives(self, entries: list[KnowledgeEntry]) -> int:
        """Hard-delete archived entries past the grace period."""
        deleted = 0
        for entry in entries:
            if entry.status != KnowledgeStatus.ARCHIVED:
                continue
            days_archived = (_now() - entry.last_accessed).total_seconds() / 86400
            if days_archived >= self.grace_period_days:
                self.store.remove(entry.id)
                deleted += 1
        return deleted

    def _archive_low_value(self) -> int:
        """Archive active entries below value threshold."""
        archived = 0
        active_entries = self.store.query(status=KnowledgeStatus.ACTIVE)
        for entry in active_entries:
            if entry.current_value < self.value_threshold:
                entry.archive()
                self.store.add(entry)  # persist status change
                archived += 1
        return archived

    def _detect_contradictions(self) -> int:
        """Find and handle contradicting knowledge pairs."""
        active = self.store.query(status=KnowledgeStatus.ACTIVE)
        contradictions = 0

        for i, entry_a in enumerate(active):
            for entry_b in active[i + 1 :]:
                if self._contradiction_fn(entry_a.content, entry_b.content):
                    contradictions += 1
                    # Keep the one with higher confidence
                    if entry_a.confidence >= entry_b.confidence:
                        entry_b.deprecate()
                        self.store.add(entry_b)
                    else:
                        entry_a.deprecate()
                        self.store.add(entry_a)
                        break  # entry_a is deprecated, move to next

        return contradictions

    def _enforce_capacity(self) -> int:
        """Archive lowest-value entries if over capacity limit."""
        active = self.store.query(status=KnowledgeStatus.ACTIVE)
        if len(active) <= self.capacity_limit:
            return 0

        # Sort by value, archive the tail
        active.sort(key=lambda e: e.current_value)
        to_archive = active[: len(active) - self.capacity_limit]
        for entry in to_archive:
            entry.archive()
            self.store.add(entry)
        return len(to_archive)
