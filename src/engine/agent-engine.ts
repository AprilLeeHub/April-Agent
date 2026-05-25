/**
 * Summary: ReAct agent loop that drives provider calls, tool execution,
 * cancellation, checkpoints, and delayed intervention flushing.
 */

import { assertToolChainAdjacency, createMessageId, createTimestamp, createToolResultMessage } from '../types/messages.js';
import type { MemoryOrchestrator } from '../knowledge/orchestrator.js';
import type { AgentCheckpoint, AgentSession, ContextInjection, Message, PendingContextInjection, PendingToolApproval, ProviderAdapter, SerializedRuntimeError, ToolCall } from '../types/index.js';
import type { CheckpointStore } from '../storage/checkpoint-store.js';
import type { SessionStore } from '../storage/session-store.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ContextManager } from './context-manager.js';
import { InterventionQueue } from './intervention-queue.js';
import { Observability } from './observability.js';
import { SessionStateMachine } from './state-machine.js';

interface AgentEngineOptions {
  model: string;
  maxSteps?: number;
  systemPrompt?: string;
  hardConstraints?: string[];
  memoryOrchestrator?: MemoryOrchestrator;
}

interface RunTurnOptions {
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface PendingToolBatchLocation {
  assistantIndex: number;
  toolCallIndex: number;
  toolCalls: ToolCall[];
}

export class AgentEngine {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly stateMachine: SessionStateMachine;
  private readonly interventionQueue: InterventionQueue;

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly sessionStore: SessionStore,
    private readonly checkpointStore: CheckpointStore,
    private readonly contextManager: ContextManager,
    private readonly observability: Observability,
    private readonly options: AgentEngineOptions,
    stateMachine = new SessionStateMachine(),
    interventionQueue = new InterventionQueue(),
  ) {
    this.stateMachine = stateMachine;
    this.interventionQueue = interventionQueue;
  }

  async createSession(sessionId: string): Promise<AgentSession> {
    return this.sessionStore.create(sessionId);
  }

  async submitUserInput(sessionId: string, content: string): Promise<AgentSession> {
    const session = await this.getOrCreateSession(sessionId);
    const nextSession = this.stateMachine.submitUserInput(session, content);
    const saved = {
      ...nextSession,
      latestUserGoal: content,
    };

    await this.sessionStore.save(saved);
    return saved;
  }

  async confirmTurn(sessionId: string): Promise<AgentSession> {
    const session = await this.getExistingSession(sessionId);
    const nextSession = this.stateMachine.confirmTurn(session);
    await this.sessionStore.save(nextSession);
    return nextSession;
  }

  async queueIntervention(sessionId: string, message: Message): Promise<AgentSession> {
    const session = await this.getExistingSession(sessionId);

    if (!this.isSafeHistory(session.messages) || session.isRunning) {
      const queued = this.interventionQueue.enqueue(session, message);
      this.observability.blocked(session.id, session.turnId, 'intervention.accept', 'Intervention queued until the current tool chain closes.');
      await this.sessionStore.save(queued);
      return queued;
    }

    const nextSession = {
      ...session,
      messages: [...session.messages, message],
      updatedAt: createTimestamp(),
    };
    this.observability.executed(session.id, session.turnId, 'intervention.accept', 'Inserted intervention into history immediately.');
    await this.sessionStore.save(nextSession);
    return nextSession;
  }

  async runTurn(sessionId: string, runOptions: RunTurnOptions = {}): Promise<AgentSession> {
    const initialSession = await this.getExistingSession(sessionId);
    const resolvedRunOptions = this.resolveRunOptions(initialSession, runOptions);
    let session = this.stateMachine.runTurn(initialSession);
    session = this.commitPendingUserTurn({
      ...session,
      isRunning: true,
      updatedAt: createTimestamp(),
    });
    session = this.attachRunOptions(session, resolvedRunOptions);
    await this.sessionStore.save(session);
    await this.writeCheckpoint('turn_start', session);

    return this.runActiveSession(session, resolvedRunOptions);
  }

  async approvePendingToolCall(sessionId: string, approvalId: string, runOptions: RunTurnOptions = {}): Promise<AgentSession> {
    const session = await this.getExistingSession(sessionId);
    const pendingApproval = this.findPendingApproval(session, approvalId);
    const resolvedRunOptions = this.resolveRunOptions(session, runOptions);
    const resumedSession = this.attachRunOptions(
      {
        ...this.stateMachine.resumeAfterApproval({
          ...session,
          pendingApprovals: session.pendingApprovals.filter((approval) => approval.id !== approvalId),
        }),
        isRunning: true,
        updatedAt: createTimestamp(),
      },
      resolvedRunOptions,
    );
    await this.sessionStore.save(resumedSession);

    return this.runActiveSession(
      resumedSession,
      resolvedRunOptions,
      async (activeSession, signal) => this.resumeApprovedToolBatch(activeSession, pendingApproval, signal),
    );
  }

  async denyPendingToolCall(
    sessionId: string,
    approvalId: string,
    reason = '审批已拒绝，本次工具调用不会执行。',
    runOptions: RunTurnOptions = {},
  ): Promise<AgentSession> {
    const session = await this.getExistingSession(sessionId);
    const pendingApproval = this.findPendingApproval(session, approvalId);
    const resolvedRunOptions = this.resolveRunOptions(session, runOptions);
    const resumedSession = this.attachRunOptions(
      {
        ...this.stateMachine.resumeAfterApproval({
          ...session,
          pendingApprovals: session.pendingApprovals.filter((approval) => approval.id !== approvalId),
        }),
        isRunning: true,
        updatedAt: createTimestamp(),
      },
      resolvedRunOptions,
    );
    await this.sessionStore.save(resumedSession);

    return this.runActiveSession(
      resumedSession,
      resolvedRunOptions,
      async (activeSession) => this.applyDeniedToolBatch(activeSession, pendingApproval, reason),
    );
  }

  async cancel(sessionId: string): Promise<AgentSession> {
    const session = await this.getExistingSession(sessionId);
    this.abortControllers.get(sessionId)?.abort();

    if (!session.isRunning && session.status !== 'running') {
      const cancelled = {
        ...this.stateMachine.cancel(session, 'cancelled'),
        isRunning: false,
        pendingContextInjections: [],
        updatedAt: createTimestamp(),
      };
      await this.sessionStore.save(cancelled);
      await this.writeCheckpoint('turn_end', cancelled);
      return cancelled;
    }

    return session;
  }

  private async runActiveSession(
    session: AgentSession,
    runOptions: RunTurnOptions,
    starter?: (session: AgentSession, signal: AbortSignal) => Promise<AgentSession>,
  ): Promise<AgentSession> {
    const localAbort = new AbortController();
    this.abortControllers.set(session.id, localAbort);
    const mergedSignal = this.mergeSignals([localAbort.signal, runOptions.signal].filter(Boolean) as AbortSignal[]);
    let activeSession = session;

    try {
      if (starter) {
        activeSession = await starter(activeSession, mergedSignal.signal);
      }

      if (activeSession.status !== 'running') {
        return activeSession;
      }

      activeSession = await this.executeReActLoop(activeSession, runOptions, mergedSignal.signal);
      return activeSession;
    } catch (error) {
      if (mergedSignal.signal.aborted || this.isCancellationError(error)) {
        const cancelled = {
          ...this.stateMachine.cancel(activeSession, 'cancelled'),
          isRunning: false,
          pendingContextInjections: [],
          updatedAt: createTimestamp(),
        };
        await this.sessionStore.save(cancelled);
        await this.writeCheckpoint('turn_end', cancelled);
        return cancelled;
      }

      const runtimeError = this.serializeError('provider_error', error);
      const failed = {
        ...this.stateMachine.markError(activeSession, runtimeError.message),
        isRunning: false,
        lastError: runtimeError,
        pendingContextInjections: [],
        updatedAt: createTimestamp(),
      };
      await this.sessionStore.save(failed);
      await this.writeCheckpoint('error', failed);
      return failed;
    } finally {
      mergedSignal.dispose();
      this.abortControllers.delete(session.id);
    }
  }

  private async flushInterventionsIfSafe(session: AgentSession): Promise<AgentSession> {
    if (!this.interventionQueue.hasPending(session)) {
      return session;
    }

    if (!this.isSafeHistory(session.messages)) {
      this.observability.blocked(session.id, session.turnId, 'intervention.accept', 'History remains inside an open tool chain.');
      return session;
    }

    const flushed = this.interventionQueue.flush(session);
    this.observability.executed(session.id, session.turnId, 'intervention.accept', 'Flushed queued intervention messages into history.');
    await this.sessionStore.save(flushed);
    return flushed;
  }

  private async executeReActLoop(
    session: AgentSession,
    runOptions: RunTurnOptions,
    signal: AbortSignal,
  ): Promise<AgentSession> {
    for (let step = 0; step < (this.options.maxSteps ?? 8); step += 1) {
      this.throwIfCancelled(signal);
      session = await this.getExistingSession(session.id);
      session = await this.flushInterventionsIfSafe(session);
      const passiveMemoryInjections = await this.buildPassiveMemoryInjections(session, signal, step);
      const activeContextInjections = [
        ...passiveMemoryInjections,
        ...this.materializeContextInjections(session.pendingContextInjections),
      ];

      const context = await this.contextManager.build({
        sessionId: session.id,
        turnId: session.turnId,
        messages: session.messages,
        ...(activeContextInjections.length > 0 ? { contextInjections: activeContextInjections } : {}),
        ...(runOptions.extra ? { extra: runOptions.extra } : {}),
        ...(this.options.systemPrompt ? { systemPrompt: this.options.systemPrompt } : {}),
        ...(session.latestUserGoal ? { goal: session.latestUserGoal } : {}),
        ...(this.options.hardConstraints ? { hardConstraints: this.options.hardConstraints } : {}),
        stateSummary: session.status,
      });

      const estimatedContextTokens = this.provider.estimateTokens(context.requestMessages, runOptions.extra);
      const tokenEstimate = this.provider.describeTokenEstimate?.();

      // 每轮发模型前都重新构建工具视图和上下文，确保新注册工具与压缩结果立即生效。
      this.throwIfCancelled(signal);
      this.observability.executed(session.id, session.turnId, 'llm.request', `Dispatching provider request for step ${step + 1}.`, {
        toolCount: this.toolRegistry.snapshot().length,
        estimatedContextTokens,
        ...(tokenEstimate ? { tokenEstimate } : {}),
      });

      const response = await this.provider.generate({
        model: this.options.model,
        messages: context.requestMessages,
        tools: this.toolRegistry.toProviderDefinitions(),
        signal,
        ...(runOptions.extra ? { extra: runOptions.extra } : {}),
      });

      this.observability.executed(session.id, session.turnId, 'llm.response', `Received provider response for step ${step + 1}.`, {
        finishReason: response.assistant.finishReason ?? 'stop',
        estimatedContextTokens,
        ...(tokenEstimate ? { tokenEstimate } : {}),
        ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
        ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
      });

      session = {
        ...session,
        pendingContextInjections: this.consumePendingContextInjections(session.pendingContextInjections),
        messages: [...session.messages, response.assistant],
        updatedAt: createTimestamp(),
      };
      await this.sessionStore.save(session);
      await this.writeCheckpoint('llm_response', session);

      if (!response.assistant.toolCalls?.length) {
        const completed = {
          ...this.stateMachine.markCompleted(session, 'assistant_completed'),
          isRunning: false,
          pendingContextInjections: [],
          updatedAt: createTimestamp(),
        };
        await this.sessionStore.save(completed);
        await this.writeCheckpoint('turn_end', completed);
        return completed;
      }

      session = await this.executeToolBatch(session, response.assistant.toolCalls, signal);
      if (session.status === 'awaiting_approval') {
        return session;
      }

      assertToolChainAdjacency(session.messages);
      session = await this.getExistingSession(session.id);
      session = await this.flushInterventionsIfSafe(session);
    }

    const completed = {
      ...this.stateMachine.markCompleted(session, 'max_steps'),
      isRunning: false,
      pendingContextInjections: [],
      updatedAt: createTimestamp(),
    };
    await this.sessionStore.save(completed);
    await this.writeCheckpoint('turn_end', completed);
    return completed;
  }

  private async executeToolBatch(
    session: AgentSession,
    toolCalls: ToolCall[],
    signal: AbortSignal,
    options: { startIndex?: number; skipApprovalToolCallId?: string } = {},
  ): Promise<AgentSession> {
    for (let toolCallIndex = options.startIndex ?? 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const toolCall = toolCalls[toolCallIndex]!;
      this.throwIfCancelled(signal);
      const result = await this.toolExecutor.execute(
        toolCall,
        session,
        {
          sessionId: session.id,
          turnId: session.turnId,
          signal,
        },
        {
          skipApproval: options.skipApprovalToolCallId === toolCall.id,
        },
      );

      const latestSession = await this.getExistingSession(session.id);
      session = {
        ...session,
        pendingApprovals: session.pendingApprovals.length > 0
          ? session.pendingApprovals
          : latestSession.pendingApprovals,
        pendingInterventions: latestSession.pendingInterventions,
        pendingContextInjections: this.mergePendingContextInjections(latestSession.pendingContextInjections, result.contextInjections),
        messages: [...session.messages, result.toolMessage],
        updatedAt: createTimestamp(),
      };

      if (result.pendingApproval) {
        const deferredToolMessages = toolCalls
          .slice(toolCallIndex + 1)
          .map((pendingToolCall) => this.buildDeferredToolMessage(pendingToolCall, result.pendingApproval!.message));

        // 命中审批时立即闭合当前 assistant 的整段 tool_result，避免留下未闭合协议片段。
        session = {
          ...this.stateMachine.markAwaitingApproval(session),
          messages: [...session.messages, ...deferredToolMessages],
          isRunning: false,
          updatedAt: createTimestamp(),
        };
      }

      await this.sessionStore.save(session);
      await this.writeCheckpoint('tool_result', session);

      if (result.pendingApproval) {
        return session;
      }

      this.throwIfCancelled(signal);
    }

    return session;
  }

  private commitPendingUserTurn(session: AgentSession): AgentSession {
    if (!session.pendingUserTurn) {
      return session;
    }

    const { pendingUserTurn, ...rest } = session;
    return {
      ...rest,
      messages: [
        ...session.messages,
        {
          id: createMessageId('user'),
          role: 'user',
          createdAt: pendingUserTurn.submittedAt,
          content: pendingUserTurn.content,
        },
      ],
      latestUserGoal: pendingUserTurn.content,
      updatedAt: createTimestamp(),
    };
  }

  private materializeContextInjections(pendingContextInjections: PendingContextInjection[]): ContextInjection[] {
    return pendingContextInjections
      .filter((injection) => injection.turnsRemaining > 0)
      .map((injection) => ({
        source: injection.source,
        content: injection.content,
      }));
  }

  private consumePendingContextInjections(pendingContextInjections: PendingContextInjection[]): PendingContextInjection[] {
    return pendingContextInjections
      .map((injection) => ({
        ...injection,
        turnsRemaining: injection.turnsRemaining - 1,
      }))
      .filter((injection) => injection.turnsRemaining > 0);
  }

  private mergePendingContextInjections(
    existing: PendingContextInjection[],
    next: ContextInjection[] | undefined,
  ): PendingContextInjection[] {
    if (!next || next.length === 0) {
      return existing;
    }

    const merged = [...existing];
    const seen = new Set(existing.map((injection) => `${injection.source}\0${injection.content}`));

    for (const injection of next) {
      const key = `${injection.source}\0${injection.content}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push({
        ...injection,
        createdAt: createTimestamp(),
        turnsRemaining: 1,
      });
    }

    return merged;
  }

  private buildDeferredToolMessage(toolCall: { id: string; name: string }, reason: string): Message {
    return createToolResultMessage(
      toolCall.id,
      toolCall.name,
      `Deferred because another tool call is awaiting approval. ${reason}`,
      {
        isError: true,
        summary: `Deferred until approval resolves for another tool call. ${reason}`,
        metadata: {
          deferred: true,
          blocked: true,
        },
      },
    );
  }

  private buildDeniedToolMessage(pendingApproval: PendingToolApproval, reason: string): Message {
    return createToolResultMessage(
      pendingApproval.toolCallId,
      pendingApproval.toolName,
      `工具执行已被拒绝。${reason}`,
      {
        isError: true,
        summary: `审批被拒绝。${reason}`,
        metadata: {
          approvalId: pendingApproval.id,
          approvalDenied: true,
          blocked: true,
          denialReason: reason,
        },
      },
    );
  }

  private async resumeApprovedToolBatch(
    session: AgentSession,
    pendingApproval: PendingToolApproval,
    signal: AbortSignal,
  ): Promise<AgentSession> {
    const batchLocation = this.locatePendingToolBatch(session, pendingApproval);
    const trimmedSession = {
      ...session,
      messages: session.messages.slice(0, batchLocation.assistantIndex + 1 + batchLocation.toolCallIndex),
      updatedAt: createTimestamp(),
    };
    await this.sessionStore.save(trimmedSession);

    // 批准后从被拦下的那个 toolCall 继续，后续同批工具按原顺序接着执行。
    return this.executeToolBatch(trimmedSession, batchLocation.toolCalls, signal, {
      startIndex: batchLocation.toolCallIndex,
      skipApprovalToolCallId: pendingApproval.toolCallId,
    });
  }

  private async applyDeniedToolBatch(
    session: AgentSession,
    pendingApproval: PendingToolApproval,
    reason: string,
  ): Promise<AgentSession> {
    const batchLocation = this.locatePendingToolBatch(session, pendingApproval);
    const deniedToolMessage = this.buildDeniedToolMessage(pendingApproval, reason);
    const deferredToolMessages = batchLocation.toolCalls
      .slice(batchLocation.toolCallIndex + 1)
      .map((toolCall) => this.buildDeferredToolMessage(toolCall, reason));
    const nextSession = {
      ...session,
      messages: [
        ...session.messages.slice(0, batchLocation.assistantIndex + 1 + batchLocation.toolCallIndex),
        deniedToolMessage,
        ...deferredToolMessages,
      ],
      updatedAt: createTimestamp(),
    };

    assertToolChainAdjacency(nextSession.messages);
    await this.sessionStore.save(nextSession);
    await this.writeCheckpoint('tool_result', nextSession);
    return nextSession;
  }

  private locatePendingToolBatch(
    session: AgentSession,
    pendingApproval: PendingToolApproval,
  ): PendingToolBatchLocation {
    for (let messageIndex = session.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = session.messages[messageIndex];
      if (message?.role !== 'assistant' || !message.toolCalls?.length) {
        continue;
      }

      const toolCallIndex = message.toolCalls.findIndex((toolCall) => toolCall.id === pendingApproval.toolCallId);
      if (toolCallIndex === -1) {
        continue;
      }

      return {
        assistantIndex: messageIndex,
        toolCallIndex,
        toolCalls: message.toolCalls,
      };
    }

    throw new Error(`Could not locate tool batch for approval ${pendingApproval.id}.`);
  }

  private findPendingApproval(session: AgentSession, approvalId: string): PendingToolApproval {
    if (session.status !== 'awaiting_approval') {
      throw new Error(`Session ${session.id} is not waiting for approval.`);
    }

    const pendingApproval = session.pendingApprovals.find((approval) => approval.id === approvalId);
    if (!pendingApproval) {
      throw new Error(`Pending approval ${approvalId} was not found.`);
    }

    return pendingApproval;
  }

  private resolveRunOptions(session: AgentSession, runOptions: RunTurnOptions): RunTurnOptions {
    return {
      ...runOptions,
      ...(runOptions.extra ? {} : session.lastRunExtra ? { extra: session.lastRunExtra } : {}),
    };
  }

  private attachRunOptions(session: AgentSession, runOptions: RunTurnOptions): AgentSession {
    if (!runOptions.extra) {
      return session;
    }

    return {
      ...session,
      lastRunExtra: runOptions.extra,
    };
  }

  private async writeCheckpoint(stage: AgentCheckpoint['stage'], session: AgentSession): Promise<void> {
    const checkpoint = {
      sessionId: session.id,
      turnId: session.turnId,
      stage,
      session,
      createdAt: createTimestamp(),
      decisionEvents: this.observability.list(session.id),
    } satisfies AgentCheckpoint;

    await this.checkpointStore.append(checkpoint);
    if (stage === 'turn_end' && this.options.memoryOrchestrator) {
      // 回合提炼不阻塞主流程，异步落地为 episodic memory。
      void this.extractTurnMemory(checkpoint);
    }
  }

  private async buildPassiveMemoryInjections(
    session: AgentSession,
    signal: AbortSignal,
    step: number,
  ): Promise<ContextInjection[]> {
    if (step > 0 || !this.options.memoryOrchestrator || !session.latestUserGoal) {
      return [];
    }

    try {
      const injections = await this.options.memoryOrchestrator.recall({
        session,
        query: session.latestUserGoal,
        signal,
      });

      this.observability[injections.length > 0 ? 'executed' : 'skipped'](
        session.id,
        session.turnId,
        'memory.recall',
        injections.length > 0
          ? `Recalled ${injections.length} memory snippet(s) for the upcoming turn.`
          : 'No relevant memory snippets matched the current user goal.',
        {
          count: injections.length,
        },
      );
      return injections;
    } catch (error) {
      this.observability.error(
        session.id,
        session.turnId,
        'memory.recall',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  private async extractTurnMemory(checkpoint: AgentCheckpoint): Promise<void> {
    if (!this.options.memoryOrchestrator) {
      return;
    }

    try {
      const checkpoints = await this.checkpointStore.list(checkpoint.sessionId);
      const previousTurnEndCheckpoint = checkpoints
        .slice(0, -1)
        .reverse()
        .find((candidate) => candidate.stage === 'turn_end');
      const extracted = await this.options.memoryOrchestrator.extractTurn({
        session: checkpoint.session,
        checkpoint,
        ...(previousTurnEndCheckpoint ? { previousTurnEndCheckpoint } : {}),
      });

      this.observability[extracted ? 'executed' : 'skipped'](
        checkpoint.sessionId,
        checkpoint.turnId,
        'memory.extract',
        extracted
          ? `Persisted episodic memory ${extracted.id}.`
          : 'No durable episodic memory was produced for this turn.',
        extracted?.path ? { path: extracted.path } : undefined,
      );
    } catch (error) {
      this.observability.error(
        checkpoint.sessionId,
        checkpoint.turnId,
        'memory.extract',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private mergeSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const listeners = signals.map((signal) => {
      const listener = () => controller.abort();
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) {
        controller.abort();
      }

      return { signal, listener };
    });

    return {
      signal: controller.signal,
      dispose: () => {
        for (const { signal, listener } of listeners) {
          signal.removeEventListener('abort', listener);
        }
      },
    };
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error('cancelled');
    }
  }

  private isSafeHistory(messages: Message[]): boolean {
    try {
      assertToolChainAdjacency(messages);
      return true;
    } catch {
      return false;
    }
  }

  private isCancellationError(error: unknown): boolean {
    return error instanceof Error && /cancel/i.test(error.message);
  }

  private serializeError(kind: SerializedRuntimeError['kind'], error: unknown): SerializedRuntimeError {
    if (error instanceof Error) {
      return {
        kind,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      };
    }

    return {
      kind,
      message: String(error),
    };
  }

  private async getOrCreateSession(sessionId: string): Promise<AgentSession> {
    return (await this.sessionStore.get(sessionId)) ?? this.sessionStore.create(sessionId);
  }

  private async getExistingSession(sessionId: string): Promise<AgentSession> {
    const session = await this.getOrCreateSession(sessionId);
    return session;
  }
}