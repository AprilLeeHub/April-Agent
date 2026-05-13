/**
 * Summary: Runtime assembly helper that wires stores, observability, built-in
 * tools, and the agent engine into a single embeddable object.
 */

import { AgentEngine } from '../engine/agent-engine.js';
import { ContextManager } from '../engine/context-manager.js';
import { Observability } from '../engine/observability.js';
import type {
  ProviderAdapter,
  SummaryModelConfig,
  ToolDefinition,
  ToolExecutionBackend,
  ToolExecutionPolicy,
  ToolOutputProcessor,
} from '../types/index.js';
import { MemoryArtifactStore } from '../storage/artifact-store.js';
import { MemoryCheckpointStore } from '../storage/checkpoint-store.js';
import { MemorySessionStore } from '../storage/session-store.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBashTool } from '../tools/builtin/bash-tool.js';
import { createFileTools } from '../tools/builtin/file-tools.js';
import { createSearchTools } from '../tools/builtin/search-tools.js';
import { ProviderSummaryProvider } from './provider-summary.js';

export interface CreateRuntimeSummaryOptions {
  provider?: ProviderAdapter;
  config: SummaryModelConfig;
}

export interface CreateRuntimeToolExecutionOptions {
  timeoutMs?: number;
  loopGuardThreshold?: number;
  loopGuardWindowMs?: number;
  policies?: ToolExecutionPolicy[];
  backend?: ToolExecutionBackend;
  outputProcessor?: ToolOutputProcessor;
}

export interface CreateRuntimeOptions {
  provider: ProviderAdapter;
  model: string;
  rootDir: string;
  maxSteps?: number;
  systemPrompt?: string;
  hardConstraints?: string[];
  additionalTools?: ToolDefinition[];
  summary?: CreateRuntimeSummaryOptions;
  toolExecution?: CreateRuntimeToolExecutionOptions;
}

export function createRuntime(options: CreateRuntimeOptions) {
  const observability = new Observability();
  const sessionStore = new MemorySessionStore();
  const checkpointStore = new MemoryCheckpointStore();
  const artifactStore = new MemoryArtifactStore();
  const registry = new ToolRegistry();
  const summaryProvider = options.summary
    ? new ProviderSummaryProvider(options.summary.provider ?? options.provider, options.summary.config)
    : undefined;
  const contextManager = new ContextManager(
    options.provider,
    observability,
    summaryProvider,
    {
      ...(options.summary?.config.triggerRatio !== undefined ? { softWatermark: options.summary.config.triggerRatio } : {}),
      ...(options.summary?.config.hysteresis !== undefined ? { hysteresis: options.summary.config.hysteresis } : {}),
    },
  );

  registry.registerMany([
    ...createFileTools({ rootDir: options.rootDir }),
    ...createSearchTools({ rootDir: options.rootDir }),
    createBashTool({ rootDir: options.rootDir }),
    ...(options.additionalTools ?? []),
  ]);

  const engine = new AgentEngine(
    options.provider,
    registry,
    new ToolExecutor(registry, artifactStore, observability, {
      ...(options.toolExecution ?? {}),
    }),
    sessionStore,
    checkpointStore,
    contextManager,
    observability,
    {
      model: options.model,
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.hardConstraints ? { hardConstraints: options.hardConstraints } : {}),
    },
  );

  return {
    engine,
    registry,
    observability,
    sessionStore,
    checkpointStore,
    artifactStore,
    contextManager,
    summaryProvider,
  };
}