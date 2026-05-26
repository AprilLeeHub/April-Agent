# Copilot Instructions

## Project Overview

April-Agent is a ReAct (Reasoning + Acting) agent runtime demo implemented in Python, featuring memory management, context compression, and retry mechanisms.

## Conventions

- Language: Python 3.10+
- Use type hints for all function signatures
- Follow PEP 8 style guidelines
- Use `asyncio` for async operations
- Retry logic should use exponential backoff with jitter
- All API interactions must have configurable retry policies
- Tests use `pytest` and `pytest-asyncio`

## Architecture Principles

### Token Budget Awareness

All modules interacting with the LLM context window must respect `TokenBudget`:
- Context compression is **always** executed before memory recall
- Memory recall operates within the remaining token budget after compression
- Session consolidation runs asynchronously and does not block the main loop

### Memory Layer Hierarchy

| Layer | Purpose | Recall Timing |
|-------|---------|---------------|
| L0 - Project Context | Project metadata, tools, structure | Always on session start |
| L1 - User Preferences | Personal settings, habits | Always on session start |
| L2 - Task Patterns | Historical Q&A, task patterns | Similarity-based recall |
| L3 - Deep Knowledge | Domain knowledge, decisions | Explicit trigger only |

### Knowledge Lifecycle

- All knowledge entries have `confidence`, `decay_rate`, and `access_count`
- Cleanup runs periodically: archive low-value entries, detect contradictions
- Soft-delete first (30-day grace period), then hard-delete

## Priority Order for Implementation

```
P0: Context Compression (guarantees task quality)
P1: L0 Project Context (eliminates redundant runtime loops)
P2: Memory Recall (L1/L2 cross-session experience)
P3: Knowledge Cleanup (system sustainability)
P4: Cross-session Cache (token optimization)
```

## Project Structure

```
src/              - Source code
  retry.py        - Retry utilities with exponential backoff
  agent.py        - ReAct agent runtime
docs/             - Design documents and reviews
tests/            - Test files
```

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/
```
