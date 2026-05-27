"""Tests for cache layers."""

import tempfile
import time
from pathlib import Path

from src.memory.cache import SessionCache, CrossSessionCache


class TestSessionCache:
    def test_put_and_get(self) -> None:
        cache = SessionCache()
        cache.put("q1", "answer1")
        assert cache.get("q1") == "answer1"

    def test_cache_miss(self) -> None:
        cache = SessionCache()
        assert cache.get("missing") is None

    def test_lru_eviction(self) -> None:
        cache = SessionCache(max_size=2)
        cache.put("a", "1")
        cache.put("b", "2")
        cache.put("c", "3")  # should evict "a"
        assert cache.get("a") is None
        assert cache.get("b") == "2"
        assert cache.get("c") == "3"

    def test_invalidate(self) -> None:
        cache = SessionCache()
        cache.put("k", "v")
        assert cache.invalidate("k") is True
        assert cache.get("k") is None
        assert cache.invalidate("k") is False

    def test_clear(self) -> None:
        cache = SessionCache()
        cache.put("a", "1")
        cache.put("b", "2")
        cache.clear()
        assert cache.size == 0


class TestCrossSessionCache:
    def test_put_and_get(self) -> None:
        cache = CrossSessionCache()
        cache.put("user1", "proj1", "what tools?", "retry, agent")
        assert cache.get("user1", "proj1", "what tools?") == "retry, agent"

    def test_miss(self) -> None:
        cache = CrossSessionCache()
        assert cache.get("u", "p", "q") is None

    def test_ttl_expiry(self) -> None:
        cache = CrossSessionCache(default_ttl=0.01)  # 10ms TTL
        cache.put("u", "p", "q", "val")
        time.sleep(0.02)
        assert cache.get("u", "p", "q") is None

    def test_invalidate_project(self) -> None:
        cache = CrossSessionCache()
        cache.put("u1", "proj1", "q1", "v1")
        cache.put("u1", "proj1", "q2", "v2")
        cache.put("u1", "proj2", "q1", "v3")
        removed = cache.invalidate_project("proj1")
        assert removed == 2
        assert cache.get("u1", "proj1", "q1") is None
        assert cache.get("u1", "proj2", "q1") == "v3"

    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"
            cache = CrossSessionCache(storage_path=path)
            cache.put("u", "p", "q", "v")

            cache2 = CrossSessionCache(storage_path=path)
            assert cache2.get("u", "p", "q") == "v"

    def test_capacity_eviction(self) -> None:
        cache = CrossSessionCache(max_size=2)
        cache.put("u", "p", "q1", "v1")
        cache.put("u", "p", "q2", "v2")
        cache.put("u", "p", "q3", "v3")
        assert cache.size <= 2
