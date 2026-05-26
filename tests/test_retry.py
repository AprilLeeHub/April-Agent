"""Tests for retry utilities."""

import asyncio

import pytest

from src.retry import RetryConfig, RetryError, compute_delay, retry_async, retry_sync


class TestComputeDelay:
    def test_exponential_backoff(self) -> None:
        config = RetryConfig(base_delay=1.0, exponential_base=2.0, jitter=False)
        assert compute_delay(0, config) == 1.0
        assert compute_delay(1, config) == 2.0
        assert compute_delay(2, config) == 4.0

    def test_max_delay_cap(self) -> None:
        config = RetryConfig(base_delay=1.0, max_delay=5.0, jitter=False)
        assert compute_delay(10, config) == 5.0

    def test_jitter_produces_varied_delays(self) -> None:
        config = RetryConfig(base_delay=1.0, jitter=True)
        delays = [compute_delay(2, config) for _ in range(100)]
        # With jitter, delays should vary
        assert len(set(delays)) > 1
        # All delays should be within bounds
        assert all(0 <= d <= 4.0 for d in delays)


class TestRetryAsync:
    @pytest.mark.asyncio
    async def test_succeeds_on_first_try(self) -> None:
        call_count = 0

        async def succeed() -> str:
            nonlocal call_count
            call_count += 1
            return "ok"

        result = await retry_async(succeed)
        assert result == "ok"
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_retries_on_failure_then_succeeds(self) -> None:
        call_count = 0

        async def fail_twice() -> str:
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ValueError("transient error")
            return "recovered"

        config = RetryConfig(
            max_retries=3,
            base_delay=0.01,
            retryable_exceptions=[ValueError],
        )
        result = await retry_async(fail_twice, config=config)
        assert result == "recovered"
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_raises_retry_error_when_exhausted(self) -> None:
        async def always_fail() -> None:
            raise ConnectionError("failed")

        config = RetryConfig(
            max_retries=2,
            base_delay=0.01,
            retryable_exceptions=[ConnectionError],
        )
        with pytest.raises(RetryError) as exc_info:
            await retry_async(always_fail, config=config)

        assert exc_info.value.attempts == 3
        assert isinstance(exc_info.value.last_exception, ConnectionError)

    @pytest.mark.asyncio
    async def test_non_retryable_exception_raises_immediately(self) -> None:
        call_count = 0

        async def raise_type_error() -> None:
            nonlocal call_count
            call_count += 1
            raise TypeError("not retryable")

        config = RetryConfig(
            max_retries=3,
            base_delay=0.01,
            retryable_exceptions=[ValueError],
        )
        with pytest.raises(TypeError):
            await retry_async(raise_type_error, config=config)

        assert call_count == 1


class TestRetrySync:
    def test_succeeds_on_first_try(self) -> None:
        call_count = 0

        def succeed() -> str:
            nonlocal call_count
            call_count += 1
            return "ok"

        result = retry_sync(succeed)
        assert result == "ok"
        assert call_count == 1

    def test_retries_on_failure_then_succeeds(self) -> None:
        call_count = 0

        def fail_once() -> str:
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ValueError("transient")
            return "recovered"

        config = RetryConfig(
            max_retries=2,
            base_delay=0.01,
            retryable_exceptions=[ValueError],
        )
        result = retry_sync(fail_once, config=config)
        assert result == "recovered"
        assert call_count == 2

    def test_raises_retry_error_when_exhausted(self) -> None:
        def always_fail() -> None:
            raise IOError("failed")

        config = RetryConfig(
            max_retries=1,
            base_delay=0.01,
            retryable_exceptions=[IOError],
        )
        with pytest.raises(RetryError) as exc_info:
            retry_sync(always_fail, config=config)

        assert exc_info.value.attempts == 2
