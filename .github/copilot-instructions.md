# Copilot Instructions

## Project Overview

April-Agent is a ReAct (Reasoning + Acting) agent runtime demo implemented in Node.js + TypeScript, featuring memory management, context compression, and retry mechanisms.

## Conventions

- Language: TypeScript (Node.js, ES2022 target)
- Use strict TypeScript with explicit types for all function signatures
- Use interfaces for data shapes, classes for stateful components
- Use `async/await` for async operations
- Retry logic should use exponential backoff with jitter
- All API interactions must have configurable retry policies
- Tests use Jest with `ts-jest`

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
  index.ts        - Package entry point / re-exports
  memory/         - Memory system
    tokenBudget.ts    - Token budget management
    compressor.ts     - Context compression (P0)
    projectContext.ts - L0 project context store (P1)
    recall.ts         - Memory recall orchestration (P2)
    knowledge.ts      - Knowledge entry model & store (P3)
    cleanup.ts        - Knowledge lifecycle cleanup (P3)
    cache.ts          - Session & cross-session cache (P4)
docs/             - Design documents and reviews
tests/            - Test files (*.test.ts)
```

## Running Tests

```bash
npm install
npm test
```
