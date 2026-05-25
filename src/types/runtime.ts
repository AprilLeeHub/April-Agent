/**
 * Summary: Runtime state, session, checkpoint, provider, and observability
 * contracts used across the engine, llm, tools, and storage layers.
 */

import type { JsonValue, Message, ToolCall, ToolChainReceipt, ToolMessage } from './messages.js';

export type RuntimeStatus =
  | 'awaiting_input'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'errored';

export type TerminationReason =
  | 'assistant_completed'
  | 'cancelled'
  | 'max_steps'
  | 'error';

export type DecisionEventState = 'executed' | 'skipped' | 'blocked' | 'error';

export interface DecisionEvent {
  id: string;
  sessionId: string;
  turnId: string;
  decision: string;
  state: DecisionEventState;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PendingUserTurn {
  content: string;
  submittedAt: string;
  confirmedAt?: string;
}

export interface ToolCallFingerprint {
  signature: string;
  seenAt: string;
}

export type ApprovalRisk = 'medium' | 'high';

export interface ToolApprovalRequirement {
  reason: string;
  risk: ApprovalRisk;
  message?: string;
}

export interface PendingToolApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  inputSummary: string;
  reason: string;
  risk: ApprovalRisk;
  message: string;
  createdAt: string;
}

export interface SerializedRuntimeError {
  kind: 'provider_error' | 'tool_error' | 'storage_error' | 'state_machine_error' | 'protocol_error';
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface AgentSession {
  id: string;
  turnId: string;
  status: RuntimeStatus;
  messages: Message[];
  pendingUserTurn?: PendingUserTurn;
  pendingApprovals: PendingToolApproval[];
  pendingInterventions: Message[];
  pendingContextInjections: PendingContextInjection[];
  toolCallHistory: ToolCallFingerprint[];
  createdAt: string;
  updatedAt: string;
  lastRunExtra?: Record<string, unknown>;
  terminationReason?: TerminationReason;
  errorMessage?: string;
  lastError?: SerializedRuntimeError;
  latestUserGoal?: string;
  isRunning: boolean;
  metadata?: Record<string, unknown>;
  summaryCutoff?: number;
}

export interface AgentCheckpoint {
  sessionId: string;
  turnId: string;
  stage: 'turn_start' | 'llm_response' | 'tool_result' | 'turn_end' | 'error';
  session: AgentSession;
  createdAt: string;
  decisionEvents: DecisionEvent[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  toolName: string;
  createdAt: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CancellationState {
  aborted: boolean;
  reason?: string;
}

export interface CancellationContext {
  signal: AbortSignal;
  throwIfCancelled(): void;
}

export interface RunContext {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
}

export interface RuntimeContext {
  sessionId: string;
  turnId: string;
  cancellation: CancellationContext;
  maxSteps: number;
}

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
}

export interface ParsedToolCall {
  toolCall: ToolCall;
  inputSummary: string;
}

export interface MatchedPolicyRule {
  policy: string;
  rule: string;
  message: string;
  metadata?: Record<string, JsonValue>;
}

export interface RiskAssessment {
  level: 'low' | ApprovalRisk;
  reason: string;
  matchedRules: MatchedPolicyRule[];
}

export interface ContextInjection {
  source: string;
  content: string;
}

export interface PendingContextInjection extends ContextInjection {
  createdAt: string;
  turnsRemaining: number;
}

export interface ApprovalRoute {
  action: 'allow' | 'review' | 'deny';
  reason: string;
  risk?: ApprovalRisk;
  message?: string;
}

export interface SandboxConstraints {
  timeoutMs?: number;
  maxOutputChars?: number;
  workingDirectory?: string;
  allowedEnvVars?: string[];
  allowedPaths?: string[];
}

export interface ToolPolicyDecision {
  action: 'allow' | 'review' | 'deny';
  reason: string;
  message: string;
  matchedRules?: MatchedPolicyRule[];
  riskAssessment?: RiskAssessment;
  approvalRoute?: ApprovalRoute;
  contextInjections?: ContextInjection[];
  sandbox?: SandboxConstraints;
  metadata?: Record<string, JsonValue>;
}

export interface ToolPolicyContext {
  tool: ToolDefinition;
  toolCall: ToolCall;
  parsedToolCall: ParsedToolCall;
  session: AgentSession;
  context: ToolExecutionContext;
  skipApproval?: boolean;
}

export interface ToolExecutionPolicy {
  name: string;
  evaluate(input: ToolPolicyContext): Promise<ToolPolicyDecision | undefined> | ToolPolicyDecision | undefined;
}

export interface ToolOutputProcessingResult {
  text: string;
  summary: string;
  truncated: boolean;
  artifactId?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolOutputProcessor {
  process(
    tool: ToolDefinition,
    text: string,
    input?: { sandbox?: SandboxConstraints },
  ): Promise<ToolOutputProcessingResult>;
}

export interface ToolExecutionBackend {
  name: string;
  execute(
    tool: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    sandbox?: SandboxConstraints,
  ): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  outputKind?: 'read-file' | 'search' | 'shell' | 'default';
  inputSchema?: unknown;
  validate?: (input: unknown) => void;
  requiresApproval?: (input: unknown) => ToolApprovalRequirement | undefined;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolExecutionResult {
  toolCall: ToolCall;
  toolMessage: ToolMessage;
  receipt: ToolChainReceipt;
  blocked: boolean;
  contextInjections?: ContextInjection[];
  pendingApproval?: PendingToolApproval;
  error?: string;
}

export interface LoopGuardDecision {
  blocked: boolean;
  reason?: string;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface ProviderRequest {
  model: string;
  messages: Message[];
  tools: ProviderToolDefinition[];
  signal: AbortSignal;
  extra?: Record<string, unknown>;
}

export interface ProviderResponse {
  assistant: Extract<Message, { role: 'assistant' }>;
  raw?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ProviderCapabilities {
  supportsToolCalls: boolean;
  supportsThinking: boolean;
  contextWindow: number;
}

export interface ProviderAdapter {
  name: string;
  capabilities: ProviderCapabilities;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  estimateTokens(messages: Message[], extra?: Record<string, unknown>): number;
  describeTokenEstimate?(): {
    source: string;
    mode: 'exact' | 'approximate';
  };
}

export interface ContextBuildResult {
  requestMessages: Message[];
  receipts: ToolChainReceipt[];
  summaryInjected: boolean;
  microCompactionApplied: boolean;
}

export interface SummaryProvider {
  summarize(input: {
    sessionId: string;
    messages: Message[];
    receipts: ToolChainReceipt[];
  }): Promise<string>;
}

export interface SummaryModelConfig {
  model: string;
  systemPrompt?: string;
  maxSourceMessages?: number;
  triggerRatio?: number;
  hysteresis?: number;
  extra?: Record<string, unknown>;
}

export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
}

export interface KnowledgeSnippet {
  id: string;
  source: string;
  title: string;
  content: string;
  excerpt: string;
  score: number;
  path?: string;
  metadata?: Record<string, JsonValue>;
}

export interface KnowledgeSource {
  name: string;
  search(
    input: KnowledgeSearchInput,
    context?: {
      sessionId?: string;
      turnId?: string;
      signal?: AbortSignal;
    },
  ): Promise<KnowledgeSnippet[]>;
}

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  path?: string;
  metadata?: Record<string, JsonValue>;
}

export interface MemoryStore extends KnowledgeSource {
  save(entry: MemoryEntry): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
}

export interface MemoryMetadataContext {
  session: AgentSession;
  checkpoint: AgentCheckpoint;
  summary: string;
  messages: Message[];
  decisionEvents: DecisionEvent[];
}

export interface MemoryMetadataConfig {
  defaults?: Record<string, JsonValue>;
  resolve?: (
    context: MemoryMetadataContext,
  ) => Promise<Record<string, JsonValue> | undefined> | Record<string, JsonValue> | undefined;
}

export interface MemoryExtractionInput {
  session: AgentSession;
  checkpoint: AgentCheckpoint;
  previousTurnEndCheckpoint?: AgentCheckpoint;
}

export interface MemoryRecallInput {
  session: AgentSession;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface SessionView {
  sessionId: string;
  lastMessages: Message[];
  pendingApprovals: PendingToolApproval[];
  isRunning: boolean;
  status: RuntimeStatus;
  turnId: string;
  updatedAt: string;
  lastError?: SerializedRuntimeError;
}

export function createSession(sessionId: string): AgentSession {
  const timestamp = new Date().toISOString();
  return {
    id: sessionId,
    turnId: `${sessionId}:turn:0`,
    status: 'awaiting_input',
    messages: [],
    pendingApprovals: [],
    pendingInterventions: [],
    pendingContextInjections: [],
    toolCallHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    isRunning: false,
  };
}