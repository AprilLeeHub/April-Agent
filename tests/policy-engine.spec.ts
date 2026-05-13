import { describe, expect, it } from 'vitest';

import { ApprovalPolicy, RiskScorerPolicy, StructuredToolPreferencePolicy } from '../src/tools/policy-engine.js';
import { createSession } from '../src/types/index.js';
import type { JsonValue, ToolDefinition, ToolPolicyContext } from '../src/types/index.js';

function createContext(toolName: string, input: JsonValue): ToolPolicyContext {
  const tool: ToolDefinition = {
    name: toolName,
    description: `${toolName} tool`,
    execute: async () => 'ok',
  };

  return {
    tool,
    toolCall: {
      id: 'call-1',
      name: toolName,
      input,
    },
    parsedToolCall: {
      toolCall: {
        id: 'call-1',
        name: toolName,
        input,
      },
      inputSummary: JSON.stringify(input),
    },
    session: createSession('policy-1'),
    context: {
      sessionId: 'policy-1',
      turnId: 'policy-1:turn:0',
      signal: new AbortController().signal,
    },
  };
}

describe('policy engine policies', () => {
  it('scores network shell commands as high risk', () => {
    const decision = new RiskScorerPolicy().evaluate(createContext('bash', {
      command: 'curl',
      args: ['https://example.com'],
      shellCommand: 'curl https://example.com',
    }));

    expect(decision).toMatchObject({
      action: 'allow',
      riskAssessment: {
        level: 'high',
        reason: 'network_access',
      },
    });
    expect(decision?.matchedRules?.[0]).toMatchObject({
      policy: 'risk_scorer',
      rule: 'network_access',
    });
  });

  it('adds a structured-tool preference hint for bash file reads', () => {
    const decision = new StructuredToolPreferencePolicy().evaluate(createContext('bash', {
      command: 'cat',
      args: ['README.md'],
    }));

    expect(decision).toMatchObject({
      action: 'allow',
      reason: 'prefer_read_file',
      metadata: {
        preferredTool: 'read_file',
      },
    });
    expect(decision?.contextInjections?.[0]).toMatchObject({
      source: 'structured_tool_preference',
    });
  });

  it('still routes approval-gated tools to review after risk scoring', () => {
    const context = createContext('write_file', {
      path: 'README.md',
      content: 'hello',
    });
    context.tool.requiresApproval = () => ({
      reason: 'file_write',
      risk: 'high',
      message: 'write_file requires approval.',
    });

    const decision = new ApprovalPolicy().evaluate(context);

    expect(decision).toMatchObject({
      action: 'review',
      reason: 'file_write',
    });
  });
});