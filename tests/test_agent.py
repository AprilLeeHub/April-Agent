"""Tests for the ReAct agent."""

import pytest

from src.agent import Agent, AgentConfig
from src.retry import RetryConfig, RetryError


class TestAgent:
    @pytest.mark.asyncio
    async def test_run_produces_final_answer(self) -> None:
        async def mock_api(**kwargs) -> dict[str, str]:
            messages = kwargs.get("messages", [])
            last = messages[-1] if messages else {}
            if last.get("role") == "observation":
                return {"thought": "FINAL ANSWER: 42"}
            return {"action": "noop"}

        agent = Agent(api_call=mock_api)
        result = await agent.run("What is the answer?")
        assert result == "42"

    @pytest.mark.asyncio
    async def test_run_max_steps(self) -> None:
        async def mock_api(**kwargs) -> dict[str, str]:
            messages = kwargs.get("messages", [])
            last = messages[-1] if messages else {}
            if last.get("role") == "observation":
                return {"thought": "I need to think more"}
            return {"action": "search"}

        config = AgentConfig(max_steps=2)
        agent = Agent(api_call=mock_api, config=config)
        result = await agent.run("Solve this")
        assert result == "Max steps reached without a final answer."

    @pytest.mark.asyncio
    async def test_retries_on_api_failure(self) -> None:
        call_count = 0

        async def flaky_api(**kwargs) -> dict[str, str]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise ConnectionError("timeout")
            return {"thought": "FINAL ANSWER: done"}

        config = AgentConfig(
            retry_config=RetryConfig(
                max_retries=2,
                base_delay=0.01,
                retryable_exceptions=[ConnectionError],
            )
        )
        agent = Agent(api_call=flaky_api, config=config)
        result = await agent.run("Do something")
        assert result == "done"

    @pytest.mark.asyncio
    async def test_retry_exhaustion_propagates(self) -> None:
        async def always_fail(**kwargs) -> None:
            raise ConnectionError("down")

        config = AgentConfig(
            retry_config=RetryConfig(
                max_retries=1,
                base_delay=0.01,
                retryable_exceptions=[ConnectionError],
            )
        )
        agent = Agent(api_call=always_fail, config=config)
        with pytest.raises(RetryError):
            await agent.run("Try this")
