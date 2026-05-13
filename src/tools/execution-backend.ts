/**
 * Summary: Default backend that delegates tool execution to the registered
 * tool implementation while reserving a seam for future sandbox backends.
 */

import type { ToolDefinition, ToolExecutionBackend, ToolExecutionContext, SandboxConstraints } from '../types/index.js';

export class DefaultToolExecutionBackend implements ToolExecutionBackend {
  readonly name = 'default';

  async execute(
    tool: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    _sandbox?: SandboxConstraints,
  ): Promise<unknown> {
    return tool.execute(input, context);
  }
}