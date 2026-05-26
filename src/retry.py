"""Retry utilities with exponential backoff and jitter for API requests."""

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence, TypeVar

T = TypeVar("T")


@dataclass
class RetryConfig:
    """Configuration for retry behavior."""

    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    exponential_base: float = 2.0
    jitter: bool = True
    retryable_exceptions: Sequence[type[Exception]] = field(
        default_factory=lambda: [Exception]
    )


class RetryError(Exception):
    """Raised when all retry attempts are exhausted."""

    def __init__(self, attempts: int, last_exception: Exception) -> None:
        self.attempts = attempts
        self.last_exception = last_exception
        super().__init__(
            f"All {attempts} retry attempts failed. "
            f"Last error: {last_exception}"
        )


def compute_delay(attempt: int, config: RetryConfig) -> float:
    """Compute the delay before the next retry attempt.

    Uses exponential backoff with optional jitter.
    """
    delay = config.base_delay * (config.exponential_base ** attempt)
    delay = min(delay, config.max_delay)
    if config.jitter:
        delay = random.uniform(0, delay)
    return delay


async def retry_async(
    func: Callable[..., Any],
    *args: Any,
    config: RetryConfig | None = None,
    **kwargs: Any,
) -> Any:
    """Execute an async function with retry logic.

    Args:
        func: The async function to call.
        *args: Positional arguments for the function.
        config: Retry configuration. Uses defaults if None.
        **kwargs: Keyword arguments for the function.

    Returns:
        The result of the successful function call.

    Raises:
        RetryError: When all retry attempts are exhausted.
    """
    if config is None:
        config = RetryConfig()

    last_exception: Exception | None = None

    for attempt in range(config.max_retries + 1):
        try:
            return await func(*args, **kwargs)
        except tuple(config.retryable_exceptions) as e:
            last_exception = e
            if attempt < config.max_retries:
                delay = compute_delay(attempt, config)
                await asyncio.sleep(delay)

    raise RetryError(config.max_retries + 1, last_exception)  # type: ignore[arg-type]


def retry_sync(
    func: Callable[..., Any],
    *args: Any,
    config: RetryConfig | None = None,
    **kwargs: Any,
) -> Any:
    """Execute a synchronous function with retry logic.

    Args:
        func: The function to call.
        *args: Positional arguments for the function.
        config: Retry configuration. Uses defaults if None.
        **kwargs: Keyword arguments for the function.

    Returns:
        The result of the successful function call.

    Raises:
        RetryError: When all retry attempts are exhausted.
    """
    if config is None:
        config = RetryConfig()

    last_exception: Exception | None = None

    for attempt in range(config.max_retries + 1):
        try:
            return func(*args, **kwargs)
        except tuple(config.retryable_exceptions) as e:
            last_exception = e
            if attempt < config.max_retries:
                delay = compute_delay(attempt, config)
                import time
                time.sleep(delay)

    raise RetryError(config.max_retries + 1, last_exception)  # type: ignore[arg-type]
