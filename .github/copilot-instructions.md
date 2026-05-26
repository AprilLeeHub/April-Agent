# Copilot Instructions

## Project Overview

April-Agent is a ReAct (Reasoning + Acting) agent runtime demo implemented in Python.

## Conventions

- Language: Python 3.10+
- Use type hints for all function signatures
- Follow PEP 8 style guidelines
- Use `asyncio` for async operations
- Retry logic should use exponential backoff with jitter
- All API interactions must have configurable retry policies
- Tests use `pytest` and `pytest-asyncio`

## Project Structure

```
src/          - Source code
  retry.py   - Retry utilities with exponential backoff
  agent.py   - ReAct agent runtime
tests/        - Test files
```

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/
```
