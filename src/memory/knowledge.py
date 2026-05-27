"""Knowledge entry model and store - P3 priority.

Implements the knowledge lifecycle with decay, confidence tracking,
and source attribution.
"""

from __future__ import annotations

import math
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


def _now() -> datetime:
    return datetime.now(timezone.utc)


class KnowledgeSource(str, Enum):
    """How a knowledge entry was acquired."""

    USER_CORRECTION = "user_correction"
    AUTO_LEARNED = "auto_learned"
    IMPORTED = "imported"


class KnowledgeStatus(str, Enum):
    """Lifecycle status of a knowledge entry."""

    ACTIVE = "active"
    ARCHIVED = "archived"
    DEPRECATED = "deprecated"
    DELETED = "deleted"


@dataclass
class KnowledgeEntry:
    """A single knowledge entry with lifecycle management.

    Tracks confidence, access patterns, and decay to support
    automatic cleanup and prioritized recall.
    """

    id: str
    content: str
    source: KnowledgeSource = KnowledgeSource.AUTO_LEARNED
    confidence: float = 0.8
    decay_rate: float = 0.05
    created_at: datetime = field(default_factory=_now)
    last_accessed: datetime = field(default_factory=_now)
    access_count: int = 0
    status: KnowledgeStatus = KnowledgeStatus.ACTIVE
    tags: list[str] = field(default_factory=list)
    project_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def current_value(self) -> float:
        """Calculate current knowledge value score.

        Formula: confidence × recency_score × frequency_score
        - recency_score decays exponentially based on days since last access
        - frequency_score caps at 1.0 after 10 accesses
        """
        days_since_access = (_now() - self.last_accessed).total_seconds() / 86400
        recency_score = math.exp(-self.decay_rate * days_since_access)
        frequency_score = min(self.access_count / 10.0, 1.0)
        return self.confidence * recency_score * frequency_score

    def access(self) -> None:
        """Record an access to this knowledge entry."""
        self.last_accessed = _now()
        self.access_count += 1

    def archive(self) -> None:
        """Mark entry as archived (excluded from recall)."""
        self.status = KnowledgeStatus.ARCHIVED

    def deprecate(self) -> None:
        """Mark entry as deprecated (superseded by newer knowledge)."""
        self.status = KnowledgeStatus.DEPRECATED

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary."""
        return {
            "id": self.id,
            "content": self.content,
            "source": self.source.value,
            "confidence": self.confidence,
            "decay_rate": self.decay_rate,
            "created_at": self.created_at.isoformat(),
            "last_accessed": self.last_accessed.isoformat(),
            "access_count": self.access_count,
            "status": self.status.value,
            "tags": self.tags,
            "project_id": self.project_id,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KnowledgeEntry:
        """Deserialize from dictionary."""
        return cls(
            id=data["id"],
            content=data["content"],
            source=KnowledgeSource(data.get("source", "auto_learned")),
            confidence=data.get("confidence", 0.8),
            decay_rate=data.get("decay_rate", 0.05),
            created_at=datetime.fromisoformat(data["created_at"]) if "created_at" in data else _now(),
            last_accessed=datetime.fromisoformat(data["last_accessed"]) if "last_accessed" in data else _now(),
            access_count=data.get("access_count", 0),
            status=KnowledgeStatus(data.get("status", "active")),
            tags=data.get("tags", []),
            project_id=data.get("project_id"),
            metadata=data.get("metadata", {}),
        )


class KnowledgeStore:
    """Persistent store for knowledge entries (L2/L3 layers).

    Supports CRUD operations, querying by tags/project, and
    value-based sorting for recall prioritization.
    """

    def __init__(self, storage_path: Path | None = None) -> None:
        self._entries: dict[str, KnowledgeEntry] = {}
        self._storage_path = storage_path
        if storage_path and storage_path.exists():
            self._load()

    def _load(self) -> None:
        """Load entries from storage file."""
        if self._storage_path is None:
            return
        data = json.loads(self._storage_path.read_text(encoding="utf-8"))
        for entry_data in data:
            entry = KnowledgeEntry.from_dict(entry_data)
            self._entries[entry.id] = entry

    def _persist(self) -> None:
        """Save entries to storage file."""
        if self._storage_path is None:
            return
        data = [e.to_dict() for e in self._entries.values()]
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._storage_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def add(self, entry: KnowledgeEntry) -> None:
        """Add or update a knowledge entry."""
        self._entries[entry.id] = entry
        self._persist()

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        """Retrieve an entry by ID."""
        return self._entries.get(entry_id)

    def remove(self, entry_id: str) -> bool:
        """Remove an entry. Returns True if it existed."""
        if entry_id in self._entries:
            del self._entries[entry_id]
            self._persist()
            return True
        return False

    def query(
        self,
        *,
        project_id: str | None = None,
        tags: list[str] | None = None,
        status: KnowledgeStatus = KnowledgeStatus.ACTIVE,
        min_value: float = 0.0,
    ) -> list[KnowledgeEntry]:
        """Query entries with filters, sorted by current_value descending."""
        results = []
        for entry in self._entries.values():
            if entry.status != status:
                continue
            if project_id and entry.project_id != project_id:
                continue
            if tags and not set(tags).intersection(entry.tags):
                continue
            if entry.current_value < min_value:
                continue
            results.append(entry)
        results.sort(key=lambda e: e.current_value, reverse=True)
        return results

    def get_all(self, include_inactive: bool = False) -> list[KnowledgeEntry]:
        """Get all entries, optionally including inactive ones."""
        if include_inactive:
            return list(self._entries.values())
        return [e for e in self._entries.values() if e.status == KnowledgeStatus.ACTIVE]

    @property
    def count(self) -> int:
        """Number of entries in the store."""
        return len(self._entries)
