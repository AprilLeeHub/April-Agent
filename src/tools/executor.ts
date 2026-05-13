/**
 * Summary: Tool execution via a Claude-style middleware pipeline: policies,
 * backend dispatch, and output governance.
 */

import { createMessageId, createTimestamp, createToolResultMessage } from '../types/messages.js';
import type {
  AgentSession,
  ApprovalRisk,
  ContextInjection,
  JsonValue,
  PendingToolApproval,
  ToolCall,
  ToolExecutionBackend,
  ToolExecutionPolicy,
  ToolDefinition,
  ToolExecutionResult,
  ToolOutputProcessor,
} from '../types/index.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import { ToolRegistry } from './registry.js';
import { Observability } from '../engine/observability.js';
import { DefaultToolExecutionBackend } from './execution-backend.js';
import { DefaultToolOutputProcessor, TOOL_OUTPUT_LIMITS } from './output-processor.js';
import {
  ApprovalPolicy,
  LoopGuardPolicy,
  RiskScorerPolicy,
  StructuredToolPreferencePolicy,
  type ToolPolicyEvaluationResult,
  ToolPolicyEngine,
} from './policy-engine.js';
import { buildToolCallSignature, stableStringify, summarizeText } from './tool-utils.js';

export interface ToolExecutorOptions {
  timeoutMs?: number;
  loopGuardThreshold?: number;
  loopGuardWindowMs?: number;
  policies?: ToolExecutionPolicy[];
  backend?: ToolExecutionBackend;
  outputProcessor?: ToolOutputProcessor;
}

interface ToolExecuteOptions {
  skipApproval?: boolean;
}

export class ToolExecutor {
  private readonly policyEngine: ToolPolicyEngine;

  private readonly backend: ToolExecutionBackend;

  private readonly outputProcessor: ToolOutputProcessor;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly artifactStore: ArtifactStore,
    private readonly observability: Observability,
    private readonly options: ToolExecutorOptions = {},
  ) {
    this.backend = options.backend ?? new DefaultToolExecutionBackend();
    this.outputProcessor = options.outputProcessor ?? new DefaultToolOutputProcessor(artifactStore);
    this.policyEngine = new ToolPolicyEngine(observability, {
      policies: options.policies ?? [
        new LoopGuardPolicy({
          ...(options.loopGuardThreshold !== undefined ? { threshold: options.loopGuardThreshold } : {}),
          ...(options.loopGuardWindowMs !== undefined ? { windowMs: options.loopGuardWindowMs } : {}),
        }),
        new RiskScorerPolicy(),
        new StructuredToolPreferencePolicy(),
        new ApprovalPolicy(),
      ],
    });
  }

  async execute(
    toolCall: ToolCall,
    session: AgentSession,
    context: { sessionId: string; turnId: string; signal: AbortSignal },
    options: ToolExecuteOptions = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      this.observability.error(context.sessionId, context.turnId, 'tool.execute', `Unknown tool ${toolCall.name}.`);
      return this.buildErrorResult(toolCall, `Unknown tool ${toolCall.name}.`);
    }

    try {
      tool.validate?.(toolCall.input);

      const policyEvaluation = await this.policyEngine.evaluate({
        tool,
        toolCall,
        session,
        context,
        ...(options.skipApproval ? { skipApproval: true } : {}),
      });

      if (policyEvaluation.finalAction === 'review') {
        const pendingApproval = this.buildPendingApproval(tool, toolCall, session, policyEvaluation);
        this.observability.blocked(
          context.sessionId,
          context.turnId,
          'tool.approval',
          pendingApproval.message,
          {
            approvalId: pendingApproval.id,
            risk: pendingApproval.risk,
            toolName: pendingApproval.toolName,
          },
        );
        session.pendingApprovals = this.upsertPendingApproval(session.pendingApprovals, pendingApproval);
        return this.buildApprovalResult(toolCall, pendingApproval, policyEvaluation);
      }

      if (policyEvaluation.finalAction === 'deny') {
        const message = policyEvaluation.terminalDecision?.message ?? `Tool ${tool.name} was blocked by policy.`;
        const denialMetadata = this.buildPolicyMetadata(policyEvaluation);
        if (policyEvaluation.terminalDecision?.policyName === 'loop_guard') {
          this.observability.blocked(context.sessionId, context.turnId, 'loop.guard', message, {
            toolName: tool.name,
          });
        }

        return this.buildErrorResult(toolCall, message, {
          blocked: true,
          ...(policyEvaluation.contextInjections.length > 0 ? { contextInjections: policyEvaluation.contextInjections } : {}),
          ...(denialMetadata ? { metadata: denialMetadata } : {}),
          inputSummary: policyEvaluation.parsedToolCall.inputSummary,
        });
      }

      this.observability.executed(context.sessionId, context.turnId, 'tool.execute', `Executing ${tool.name}.`, {
        toolName: tool.name,
        backend: this.backend.name,
      });

      const rawResult = await this.executeWithTimeout(
        () => this.backend.execute(tool, toolCall.input, context, policyEvaluation.sandbox),
        context.signal,
        policyEvaluation.sandbox?.timeoutMs ?? this.options.timeoutMs ?? 10_000,
      );
      this.observability.executed(
        context.sessionId,
        context.turnId,
        `backend.${this.backend.name}`,
        `Routing ${tool.name} through ${this.backend.name}.`,
        this.mergeMetadata(
          {
            toolName: tool.name,
            backendName: this.backend.name,
            backendPath: this.describeBackendPath(tool, rawResult),
          },
          ...(policyEvaluation.sandbox ? [{ sandbox: this.toSandboxMetadata(policyEvaluation.sandbox) }] : []),
        ),
      );

      const serialized = this.serializeOutput(rawResult);
      const content = await this.outputProcessor.process(tool, serialized, {
        ...(policyEvaluation.sandbox ? { sandbox: policyEvaluation.sandbox } : {}),
      });
      this.observability.executed(
        context.sessionId,
        context.turnId,
        'output.process',
        content.truncated
          ? `Processed ${tool.name} output and offloaded the full payload to the artifact store.`
          : `Processed ${tool.name} output inline.`,
        {
          toolName: tool.name,
          truncated: content.truncated,
          ...(content.artifactId ? { artifactId: content.artifactId } : {}),
        },
      );
      session.toolCallHistory = [...session.toolCallHistory.slice(-4), { signature: this.signature(toolCall), seenAt: new Date().toISOString() }];
      const policyMetadata = this.buildPolicyMetadata(policyEvaluation);
      const backendMetadata = this.buildBackendMetadata(tool, rawResult);
      const toolMetadata = this.mergeMetadata(content.metadata, policyMetadata, backendMetadata);

      const toolMessage = createToolResultMessage(toolCall.id, tool.name, content.text, {
        summary: content.summary,
        truncated: content.truncated,
        ...(content.artifactId ? { artifactId: content.artifactId } : {}),
        ...(toolMetadata ? { metadata: toolMetadata } : {}),
      });

      return {
        toolCall,
        toolMessage,
        receipt: {
          toolCallId: toolCall.id,
          toolName: tool.name,
          inputSummary: policyEvaluation.parsedToolCall.inputSummary,
          resultSummary: content.summary,
          isError: false,
          ...(content.artifactId ? { artifactId: content.artifactId } : {}),
        },
        blocked: false,
        ...(policyEvaluation.contextInjections.length > 0 ? { contextInjections: policyEvaluation.contextInjections } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.observability.error(context.sessionId, context.turnId, 'tool.execute', message, { toolName: tool.name });
      return this.buildErrorResult(toolCall, message);
    }
  }

  private buildPendingApproval(
    tool: ToolDefinition,
    toolCall: ToolCall,
    session: AgentSession,
    policyEvaluation: ToolPolicyEvaluationResult,
  ): PendingToolApproval {
    const existing = session.pendingApprovals.find((approval) => approval.toolCallId === toolCall.id);
    if (existing) {
      return existing;
    }

    const risk = this.resolveApprovalRisk(policyEvaluation);
    const reason = policyEvaluation.terminalDecision?.approvalRoute?.reason
      ?? policyEvaluation.terminalDecision?.reason
      ?? 'policy_review';
    const message = policyEvaluation.terminalDecision?.approvalRoute?.message
      ?? policyEvaluation.terminalDecision?.message
      ?? `Tool ${tool.name} requires approval before execution.`;

    return {
      id: createMessageId('approval'),
      toolCallId: toolCall.id,
      toolName: tool.name,
      input: toolCall.input,
      inputSummary: policyEvaluation.parsedToolCall.inputSummary,
      reason,
      risk,
      message,
      createdAt: createTimestamp(),
    };
  }

  private upsertPendingApproval(
    pendingApprovals: PendingToolApproval[],
    nextApproval: PendingToolApproval,
  ): PendingToolApproval[] {
    const existingIndex = pendingApprovals.findIndex((approval) => approval.toolCallId === nextApproval.toolCallId);
    if (existingIndex === -1) {
      return [...pendingApprovals, nextApproval];
    }

    const approvals = [...pendingApprovals];
    approvals[existingIndex] = nextApproval;
    return approvals;
  }

  private resolveApprovalRisk(policyEvaluation: ToolPolicyEvaluationResult): ApprovalRisk {
    if (policyEvaluation.terminalDecision?.approvalRoute?.risk) {
      return policyEvaluation.terminalDecision.approvalRoute.risk;
    }

    return policyEvaluation.riskAssessment?.level === 'high' ? 'high' : 'medium';
  }

  private signature(toolCall: ToolCall): string {
    return buildToolCallSignature(toolCall);
  }

  private async executeWithTimeout<T>(operation: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    if (signal.aborted) {
      throw new Error('Execution cancelled before tool start.');
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      const onAbort = () => {
        cleanup();
        reject(new Error('Execution cancelled during tool run.'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      operation()
        .then((value) => {
          cleanup();
          resolve(value);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  private serializeOutput(output: unknown): string {
    if (typeof output === 'string') {
      return output;
    }

    if (Buffer.isBuffer(output)) {
      return output.toString('utf8');
    }

    return JSON.stringify(output as JsonValue, null, 2);
  }

  private buildPolicyMetadata(policyEvaluation: ToolPolicyEvaluationResult): Record<string, JsonValue> | undefined {
    const matchedRules = policyEvaluation.matchedRules.map((rule) => ({
      policy: rule.policy,
      rule: rule.rule,
      message: rule.message,
      ...(rule.metadata ? { metadata: rule.metadata } : {}),
    }));
    const contextInjections = policyEvaluation.contextInjections.map((injection) => ({
      source: injection.source,
      content: injection.content,
    }));

    const metadata = this.mergeMetadata(
      { policyAction: policyEvaluation.finalAction },
      ...(policyEvaluation.terminalDecision ? [{ policyName: policyEvaluation.terminalDecision.policyName }] : []),
      ...(matchedRules.length > 0 ? [{ matchedRules }] : []),
      ...(contextInjections.length > 0 ? [{ contextInjections }] : []),
      ...(policyEvaluation.sandbox ? [{ sandbox: this.toSandboxMetadata(policyEvaluation.sandbox) }] : []),
      ...(policyEvaluation.riskAssessment ? [{ riskLevel: policyEvaluation.riskAssessment.level, riskReason: policyEvaluation.riskAssessment.reason }] : []),
      Object.keys(policyEvaluation.metadata).length > 0 ? policyEvaluation.metadata : undefined,
    );

    return metadata;
  }

  private buildBackendMetadata(tool: ToolDefinition, rawResult: unknown): Record<string, JsonValue> {
    return {
      backendName: this.backend.name,
      backendPath: this.describeBackendPath(tool, rawResult),
    };
  }

  private describeBackendPath(tool: ToolDefinition, rawResult: unknown): string {
    const record = this.asJsonRecord(rawResult);
    const executionPath = record && typeof record.executionPath === 'string' ? record.executionPath : undefined;

    return executionPath
      ? `${this.backend.name} -> ${executionPath}`
      : `${this.backend.name} -> ${tool.name}`;
  }

  private asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, JsonValue>;
  }

  private toSandboxMetadata(sandbox: NonNullable<ToolPolicyEvaluationResult['sandbox']>): JsonValue {
    return {
      ...(sandbox.timeoutMs !== undefined ? { timeoutMs: sandbox.timeoutMs } : {}),
      ...(sandbox.maxOutputChars !== undefined ? { maxOutputChars: sandbox.maxOutputChars } : {}),
      ...(sandbox.workingDirectory !== undefined ? { workingDirectory: sandbox.workingDirectory } : {}),
      ...(sandbox.allowedEnvVars !== undefined ? { allowedEnvVars: sandbox.allowedEnvVars } : {}),
      ...(sandbox.allowedPaths !== undefined ? { allowedPaths: sandbox.allowedPaths } : {}),
    };
  }

  private mergeMetadata(
    ...entries: Array<Record<string, JsonValue> | undefined>
  ): Record<string, JsonValue> | undefined {
    const merged = Object.assign({}, ...entries.filter((entry): entry is Record<string, JsonValue> => Boolean(entry)));
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private buildErrorResult(
    toolCall: ToolCall,
    message: string,
    options: {
      blocked?: boolean;
      contextInjections?: ContextInjection[];
      metadata?: Record<string, JsonValue>;
      inputSummary?: string;
    } = {},
  ): ToolExecutionResult {
    const errorMetadata = this.mergeMetadata(
      options.blocked ? { blocked: true } : undefined,
      options.metadata,
    );

    const toolMessage = createToolResultMessage(toolCall.id, toolCall.name, message, {
      isError: true,
      summary: summarizeText(message),
      ...(errorMetadata ? { metadata: errorMetadata } : {}),
    });

    return {
      toolCall,
      toolMessage,
      receipt: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        inputSummary: options.inputSummary ?? summarizeText(stableStringify(toolCall.input)),
        resultSummary: toolMessage.content.summary,
        isError: true,
      },
      blocked: options.blocked ?? false,
      ...(options.contextInjections && options.contextInjections.length > 0 ? { contextInjections: options.contextInjections } : {}),
      error: message,
    };
  }

  private buildApprovalResult(
    toolCall: ToolCall,
    pendingApproval: PendingToolApproval,
    policyEvaluation: ToolPolicyEvaluationResult,
  ): ToolExecutionResult {
    const approvalMetadata = this.mergeMetadata(
      {
        approvalId: pendingApproval.id,
        approvalRequired: true,
        approvalReason: pendingApproval.reason,
        approvalRisk: pendingApproval.risk,
        blocked: true,
      },
      this.buildPolicyMetadata(policyEvaluation),
    );

    const toolMessage = createToolResultMessage(toolCall.id, toolCall.name, pendingApproval.message, {
      isError: true,
      summary: pendingApproval.message,
      ...(approvalMetadata ? { metadata: approvalMetadata } : {}),
    });

    return {
      toolCall,
      toolMessage,
      receipt: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        inputSummary: pendingApproval.inputSummary,
        resultSummary: pendingApproval.message,
        isError: true,
      },
      blocked: true,
      pendingApproval,
      ...(policyEvaluation.contextInjections.length > 0 ? { contextInjections: policyEvaluation.contextInjections } : {}),
      error: pendingApproval.message,
    };
  }
}

export { TOOL_OUTPUT_LIMITS };