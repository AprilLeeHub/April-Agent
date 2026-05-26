"""ReAct agent runtime with retry-enabled API calls."""

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable

from .retry import RetryConfig, retry_async


@dataclass
class AgentConfig:
    """Configuration for the ReAct agent."""

    max_steps: int = 10
    retry_config: RetryConfig = field(default_factory=RetryConfig)


class Agent:
    """A ReAct agent that reasons and acts with retry-enabled API calls."""

    def __init__(
        self,
        api_call: Callable[..., Any],
        config: AgentConfig | None = None,
    ) -> None:
        self.api_call = api_call
        self.config = config or AgentConfig()
        self.history: list[dict[str, str]] = []

    async def think(self, observation: str) -> str:
        """Generate a thought based on the observation using the API."""
        self.history.append({"role": "observation", "content": observation})

        response = await retry_async(
            self.api_call,
            messages=self.history,
            config=self.config.retry_config,
        )

        thought = response.get("thought", "")
        self.history.append({"role": "thought", "content": thought})
        return thought

    async def act(self, thought: str) -> str:
        """Determine and execute an action based on the thought."""
        self.history.append({"role": "action_request", "content": thought})

        response = await retry_async(
            self.api_call,
            messages=self.history,
            config=self.config.retry_config,
        )

        action = response.get("action", "")
        self.history.append({"role": "action", "content": action})
        return action

    async def run(self, task: str) -> str:
        """Run the ReAct loop for a given task.

        Returns:
            The final answer produced by the agent.
        """
        observation = task

        for _ in range(self.config.max_steps):
            thought = await self.think(observation)

            if thought.startswith("FINAL ANSWER:"):
                return thought.removeprefix("FINAL ANSWER:").strip()

            action = await self.act(thought)
            observation = f"Action result: {action}"

        return "Max steps reached without a final answer."
