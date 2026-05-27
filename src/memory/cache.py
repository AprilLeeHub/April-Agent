"""Cache layers for token optimization - P4 priority.

L1: Session-scoped hot cache (in-memory LRU)
L2: Cross-session warm cache (persistent, TTL-based)
"""

from __future__ import annotations

import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class CacheEntry:
    """A single cache entry with TTL support."""

    key: str
    value: str
    created_at: float = field(default_factory=time.time)
    ttl: float = 0  # 0 means no expiration (session-scoped)
    hit_count: int = 0

    @property
    def is_expired(self) -> bool:
        """Check if this entry has expired based on TTL."""
        if self.ttl <= 0:
            return False
        return (time.time() - self.created_at) > self.ttl


class SessionCache:
    """L1 Session Hot Cache - in-memory LRU.

    Stores frequently accessed query results within a single session.
    Evicts least recently used entries when capacity is reached.
    """

    def __init__(self, max_size: int = 100) -> None:
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._max_size = max_size

    def get(self, key: str) -> str | None:
        """Retrieve a cached value. Returns None on miss."""
        entry = self._cache.get(key)
        if entry is None:
            return None
        # Move to end (most recently used)
        self._cache.move_to_end(key)
        entry.hit_count += 1
        return entry.value

    def put(self, key: str, value: str) -> None:
        """Store a value in the cache."""
        if key in self._cache:
            self._cache.move_to_end(key)
            self._cache[key].value = value
        else:
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)  # Remove LRU
            self._cache[key] = CacheEntry(key=key, value=value)

    def invalidate(self, key: str) -> bool:
        """Remove a specific key. Returns True if it existed."""
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    def clear(self) -> None:
        """Clear all cached entries."""
        self._cache.clear()

    @property
    def size(self) -> int:
        """Number of entries in the cache."""
        return len(self._cache)


class CrossSessionCache:
    """L2 Cross-Session Warm Cache - persistent with TTL.

    Stores frequently used knowledge snippets across sessions.
    Uses (user_id, project_id, query) as composite key.
    Persists to a JSON file for durability across restarts.
    """

    def __init__(
        self,
        storage_path: Path | None = None,
        default_ttl: float = 7 * 24 * 3600,  # 7 days
        max_size: int = 1000,
    ) -> None:
        self._storage_path = storage_path
        self._default_ttl = default_ttl
        self._max_size = max_size
        self._cache: dict[str, CacheEntry] = {}
        if storage_path and storage_path.exists():
            self._load()

    def _make_key(self, user_id: str, project_id: str, query: str) -> str:
        """Create a composite cache key."""
        return f"{user_id}:{project_id}:{query}"

    def get(self, user_id: str, project_id: str, query: str) -> str | None:
        """Retrieve a cached value. Returns None on miss or expiry."""
        key = self._make_key(user_id, project_id, query)
        entry = self._cache.get(key)
        if entry is None:
            return None
        if entry.is_expired:
            del self._cache[key]
            self._persist()
            return None
        entry.hit_count += 1
        return entry.value

    def put(
        self,
        user_id: str,
        project_id: str,
        query: str,
        value: str,
        ttl: float | None = None,
    ) -> None:
        """Store a value in the cross-session cache."""
        key = self._make_key(user_id, project_id, query)
        self._cache[key] = CacheEntry(
            key=key,
            value=value,
            ttl=ttl if ttl is not None else self._default_ttl,
        )
        # Evict if over capacity (remove oldest expired first, then LRU)
        self._evict_if_needed()
        self._persist()

    def invalidate(self, user_id: str, project_id: str, query: str) -> bool:
        """Remove a specific cache entry."""
        key = self._make_key(user_id, project_id, query)
        if key in self._cache:
            del self._cache[key]
            self._persist()
            return True
        return False

    def invalidate_project(self, project_id: str) -> int:
        """Invalidate all entries for a project (e.g., on file changes)."""
        to_remove = [k for k, v in self._cache.items() if f":{project_id}:" in k]
        for key in to_remove:
            del self._cache[key]
        if to_remove:
            self._persist()
        return len(to_remove)

    def cleanup_expired(self) -> int:
        """Remove all expired entries. Returns count of removed entries."""
        expired = [k for k, v in self._cache.items() if v.is_expired]
        for key in expired:
            del self._cache[key]
        if expired:
            self._persist()
        return len(expired)

    def _evict_if_needed(self) -> None:
        """Evict entries if cache exceeds max size."""
        if len(self._cache) <= self._max_size:
            return
        # Remove expired first
        self.cleanup_expired()
        # If still over, remove lowest hit_count entries
        while len(self._cache) > self._max_size:
            min_key = min(self._cache, key=lambda k: self._cache[k].hit_count)
            del self._cache[min_key]

    def _load(self) -> None:
        """Load cache from storage file."""
        if self._storage_path is None:
            return
        data = json.loads(self._storage_path.read_text(encoding="utf-8"))
        for item in data:
            entry = CacheEntry(
                key=item["key"],
                value=item["value"],
                created_at=item["created_at"],
                ttl=item["ttl"],
                hit_count=item.get("hit_count", 0),
            )
            if not entry.is_expired:
                self._cache[entry.key] = entry

    def _persist(self) -> None:
        """Persist cache to storage file."""
        if self._storage_path is None:
            return
        data = [
            {
                "key": e.key,
                "value": e.value,
                "created_at": e.created_at,
                "ttl": e.ttl,
                "hit_count": e.hit_count,
            }
            for e in self._cache.values()
        ]
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._storage_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @property
    def size(self) -> int:
        """Number of entries in the cache."""
        return len(self._cache)
