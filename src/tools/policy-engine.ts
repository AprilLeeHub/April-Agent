/**
 * Summary: Claude-style policy middleware that evaluates tool calls before
 * execution and emits structured policy decisions to observability.
 */

import { Observability } from '../engine/observability.js';
import type {
  ContextInjection,
  JsonValue,
  MatchedPolicyRule,
  ParsedToolCall,
  RiskAssessment,
  SandboxConstraints,
  ToolExecutionPolicy,
  ToolPolicyContext,
  ToolPolicyDecision,
} from '../types/index.js';
import { buildToolCallSignature, stableStringify, summarizeText } from './tool-utils.js';

const HIGH_RISK_COMMANDS = {
  network: new Set(['curl', 'wget', 'scp', 'ssh']),
  destructive: new Set(['rm', 'sudo', 'dd', 'mkfs']),
  globalInstall: new Set(['npm', 'pnpm', 'yarn']),
} as const;

interface ParsedBashInput {
  command: string;
  args: string[];
  shellCommand?: string;
}

interface StructuredPreference {
  preferredTool: 'read_file' | 'list_dir' | 'grep_search';
  rule: string;
  message: string;
  hint: string;
}

function asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, JsonValue>;
}

function parseBashInput(input: ToolPolicyContext['toolCall']['input']): ParsedBashInput | undefined {
  const record = asJsonRecord(input);
  if (!record || typeof record.command !== 'string') {
    return undefined;
  }

  return {
    command: record.command,
    args: Array.isArray(record.args) ? record.args.filter((value): value is string => typeof value === 'string') : [],
    ...(typeof record.shellCommand === 'string' ? { shellCommand: record.shellCommand } : {}),
  };
}

function includesCommand(commandText: string, commands: ReadonlySet<string>): string | undefined {
  return [...commands].find((command) => {
    const pattern = new RegExp(`(^|[\\s;|&()])${command}(?=$|[\\s;|&()])`);
    return pattern.test(commandText);
  });
}

function detectStructuredPreference(input: ParsedBashInput): StructuredPreference | undefined {
  const commandText = input.shellCommand ?? [input.command, ...input.args].join(' ');

  if (['cat', 'head', 'tail', 'sed'].includes(input.command)) {
    return {
      preferredTool: 'read_file',
      rule: 'prefer_read_file',
      message: 'Prefer read_file for workspace file reads instead of using bash cat/head/tail/sed.',
      hint: 'Use read_file with path and optional line range instead of shell-based file inspection.',
    };
  }

  if (['ls', 'find', 'tree'].includes(input.command)) {
    return {
      preferredTool: 'list_dir',
      rule: 'prefer_list_dir',
      message: 'Prefer list_dir for workspace navigation instead of using ls/find/tree through bash.',
      hint: 'Use list_dir to inspect repository structure before falling back to bash.',
    };
  }

  if (['grep', 'rg'].includes(input.command) || /(^|\s)(grep|rg)(?=\s|$)/.test(commandText)) {
    return {
      preferredTool: 'grep_search',
      rule: 'prefer_grep_search',
      message: 'Prefer grep_search for repository text search instead of using grep/rg through bash.',
      hint: 'Use grep_search with a focused query and optional regex before shell search pipelines.',
    };
  }

  return undefined;
}

export interface EvaluatedToolPolicyDecision extends ToolPolicyDecision {
  policyName: string;
}

export interface ToolPolicyEvaluationResult {
  parsedToolCall: ParsedToolCall;
  decisions: EvaluatedToolPolicyDecision[];
  finalAction: 'allow' | 'review' | 'deny';
  terminalDecision?: EvaluatedToolPolicyDecision;
  matchedRules: MatchedPolicyRule[];
  riskAssessment?: RiskAssessment;
  contextInjections: ContextInjection[];
  sandbox?: SandboxConstraints;
  metadata: Record<string, JsonValue>;
}

export interface ToolPolicyEngineOptions {
  policies: ToolExecutionPolicy[];
}

function mergeSandboxConstraints(
  previous: SandboxConstraints | undefined,
  next: SandboxConstraints | undefined,
): SandboxConstraints | undefined {
  if (!previous) {
    return next ? { ...next } : undefined;
  }

  if (!next) {
    return previous;
  }

  return {
    ...previous,
    ...next,
  };
}

export class ToolPolicyEngine {
  constructor(
    private readonly observability: Observability,
    private readonly options: ToolPolicyEngineOptions,
  ) {}

  async evaluate(input: Omit<ToolPolicyContext, 'parsedToolCall'>): Promise<ToolPolicyEvaluationResult> {
    const parsedToolCall: ParsedToolCall = {
      toolCall: input.toolCall,
      inputSummary: summarizeText(stableStringify(input.toolCall.input)),
    };
    const decisions: EvaluatedToolPolicyDecision[] = [];
    const matchedRules: MatchedPolicyRule[] = [];
    const contextInjections: ContextInjection[] = [];
    let sandbox: SandboxConstraints | undefined;
    let riskAssessment: RiskAssessment | undefined;
    let metadata: Record<string, JsonValue> = {};

    for (const policy of this.options.policies) {
      const decision = await policy.evaluate({
        ...input,
        parsedToolCall,
      });

      if (!decision) {
        this.observability.skipped(
          input.context.sessionId,
          input.context.turnId,
          `policy.${policy.name}`,
          `Policy ${policy.name} did not match ${input.tool.name}.`,
          {
            toolName: input.tool.name,
          },
        );
        continue;
      }

      const evaluatedDecision: EvaluatedToolPolicyDecision = {
        ...decision,
        policyName: policy.name,
      };
      decisions.push(evaluatedDecision);
      matchedRules.push(...(decision.matchedRules ?? []));
      contextInjections.push(...(decision.contextInjections ?? []));
      sandbox = mergeSandboxConstraints(sandbox, decision.sandbox);
      riskAssessment = decision.riskAssessment ?? riskAssessment;
      metadata = {
        ...metadata,
        ...(decision.metadata ?? {}),
      };

      this.observability[decision.action === 'allow' ? 'executed' : 'blocked'](
        input.context.sessionId,
        input.context.turnId,
        `policy.${policy.name}`,
        decision.message,
        {
          toolName: input.tool.name,
          action: decision.action,
          reason: decision.reason,
          ...(decision.metadata ? { metadata: decision.metadata } : {}),
        },
      );

      if (decision.action !== 'allow') {
        return {
          parsedToolCall,
          decisions,
          finalAction: decision.action,
          terminalDecision: evaluatedDecision,
          matchedRules,
          ...(riskAssessment ? { riskAssessment } : {}),
          contextInjections,
          ...(sandbox ? { sandbox } : {}),
          metadata,
        };
      }
    }

    return {
      parsedToolCall,
      decisions,
      finalAction: 'allow',
      matchedRules,
      ...(riskAssessment ? { riskAssessment } : {}),
      contextInjections,
      ...(sandbox ? { sandbox } : {}),
      metadata,
    };
  }
}

export interface LoopGuardPolicyOptions {
  threshold?: number;
  windowMs?: number;
}

export class LoopGuardPolicy implements ToolExecutionPolicy {
  readonly name = 'loop_guard';

  constructor(private readonly options: LoopGuardPolicyOptions = {}) {}

  evaluate(input: ToolPolicyContext): ToolPolicyDecision | undefined {
    const signature = buildToolCallSignature(input.toolCall);
    const threshold = this.options.threshold ?? 5;
    const windowMs = this.options.windowMs ?? 15_000;
    const now = Date.now();

    const duplicates = input.session.toolCallHistory
      .slice(-5)
      .filter((entry) => entry.signature === signature && now - new Date(entry.seenAt).getTime() <= windowMs);

    if (duplicates.length < threshold) {
      return undefined;
    }

    const message = `Loop guard blocked repeated tool call ${input.toolCall.name} after ${duplicates.length} matching attempts in the last five calls.`;
    const matchedRule = {
      policy: this.name,
      rule: 'repeated_tool_call',
      message,
      metadata: {
        duplicates: duplicates.length,
        threshold,
        windowMs,
        signature,
      },
    } satisfies MatchedPolicyRule;

    return {
      action: 'deny',
      reason: 'repeated_tool_call',
      message,
      matchedRules: [matchedRule],
      metadata: {
        duplicates: duplicates.length,
        threshold,
        windowMs,
        signature,
      },
    };
  }
}

export class RiskScorerPolicy implements ToolExecutionPolicy {
  readonly name = 'risk_scorer';

  evaluate(input: ToolPolicyContext): ToolPolicyDecision | undefined {
    if (input.tool.name === 'bash') {
      const bashInput = parseBashInput(input.toolCall.input);
      if (!bashInput) {
        return undefined;
      }

      const commandText = bashInput.shellCommand ?? [bashInput.command, ...bashInput.args].join(' ');
      const networkCommand = includesCommand(commandText, HIGH_RISK_COMMANDS.network);
      const destructiveCommand = includesCommand(commandText, HIGH_RISK_COMMANDS.destructive);
      const globalInstallCommand =
        /\bnpm\s+install\s+-g\b/.test(commandText)
        || /\bpnpm\s+add\s+-g\b/.test(commandText)
        || /\byarn\s+global\b/.test(commandText);

      if (networkCommand) {
        return this.buildDecision(
          'high',
          'network_access',
          `RiskScorer marked the shell command as high risk because it invokes ${networkCommand}.`,
          {
            command: bashInput.command,
            commandText,
            matchedCommand: networkCommand,
          },
        );
      }

      if (destructiveCommand) {
        return this.buildDecision(
          'high',
          'destructive_command',
          `RiskScorer marked the shell command as high risk because it invokes ${destructiveCommand}.`,
          {
            command: bashInput.command,
            commandText,
            matchedCommand: destructiveCommand,
          },
        );
      }

      if (globalInstallCommand) {
        return this.buildDecision(
          'high',
          'global_install',
          'RiskScorer marked the shell command as high risk because it performs a global package installation.',
          {
            command: bashInput.command,
            commandText,
          },
        );
      }

      if (bashInput.shellCommand) {
        return this.buildDecision(
          'medium',
          'shell_syntax',
          'RiskScorer marked the shell command as medium risk because it relies on shell syntax such as pipes, redirects, or command chaining.',
          {
            command: bashInput.command,
            commandText,
          },
        );
      }

      return this.buildDecision(
        'low',
        'bounded_shell_command',
        `RiskScorer marked ${bashInput.command} as a low-risk shell command within the current workspace boundary.`,
        {
          command: bashInput.command,
          commandText,
        },
      );
    }

    if (input.tool.name === 'write_file' || input.tool.name === 'edit_file') {
      return this.buildDecision(
        'high',
        'workspace_mutation',
        `RiskScorer marked ${input.tool.name} as high risk because it modifies workspace content.`,
        {
          toolName: input.tool.name,
        },
      );
    }

    return this.buildDecision(
      'low',
      'structured_tool',
      `RiskScorer marked ${input.tool.name} as a structured low-risk tool call.`,
      {
        toolName: input.tool.name,
      },
    );
  }

  private buildDecision(
    level: RiskAssessment['level'],
    reason: string,
    message: string,
    metadata: Record<string, JsonValue>,
  ): ToolPolicyDecision {
    const matchedRule = {
      policy: this.name,
      rule: reason,
      message,
      metadata,
    } satisfies MatchedPolicyRule;

    return {
      action: 'allow',
      reason,
      message,
      matchedRules: [matchedRule],
      riskAssessment: {
        level,
        reason,
        matchedRules: [matchedRule],
      },
      metadata: {
        riskLevel: level,
        riskReason: reason,
        ...metadata,
      },
    };
  }
}

export class StructuredToolPreferencePolicy implements ToolExecutionPolicy {
  readonly name = 'structured_tool_preference';

  evaluate(input: ToolPolicyContext): ToolPolicyDecision | undefined {
    if (input.tool.name !== 'bash') {
      return undefined;
    }

    const bashInput = parseBashInput(input.toolCall.input);
    if (!bashInput) {
      return undefined;
    }

    const preference = detectStructuredPreference(bashInput);
    if (!preference) {
      return undefined;
    }

    const commandText = bashInput.shellCommand ?? [bashInput.command, ...bashInput.args].join(' ');
    const matchedRule = {
      policy: this.name,
      rule: preference.rule,
      message: preference.message,
      metadata: {
        command: bashInput.command,
        commandText,
        preferredTool: preference.preferredTool,
      },
    } satisfies MatchedPolicyRule;

    return {
      action: 'allow',
      reason: preference.rule,
      message: preference.message,
      matchedRules: [matchedRule],
      contextInjections: [
        {
          source: this.name,
          content: preference.hint,
        },
      ],
      metadata: {
        preferredTool: preference.preferredTool,
        preferredToolReason: preference.rule,
      },
    };
  }
}

export class ApprovalPolicy implements ToolExecutionPolicy {
  readonly name = 'approval';

  evaluate(input: ToolPolicyContext): ToolPolicyDecision | undefined {
    if (input.skipApproval) {
      return undefined;
    }

    const requirement = input.tool.requiresApproval?.(input.toolCall.input);
    if (!requirement) {
      return undefined;
    }

    const message = requirement.message ?? `Tool ${input.tool.name} requires approval before execution.`;
    const matchedRule = {
      policy: this.name,
      rule: requirement.reason,
      message,
      metadata: {
        risk: requirement.risk,
      },
    } satisfies MatchedPolicyRule;

    return {
      action: 'review',
      reason: requirement.reason,
      message,
      matchedRules: [matchedRule],
      riskAssessment: {
        level: requirement.risk,
        reason: requirement.reason,
        matchedRules: [matchedRule],
      },
      approvalRoute: {
        action: 'review',
        reason: requirement.reason,
        risk: requirement.risk,
        message,
      },
      metadata: {
        approvalReason: requirement.reason,
        approvalRisk: requirement.risk,
      },
    };
  }
}