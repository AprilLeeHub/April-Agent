/**
 * Summary: Tool registration and per-round snapshot building without run-level
 * caching, so newly registered tools appear on the next model turn.
 */

import type { ProviderToolDefinition, ToolDefinition } from '../types/index.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }

    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  snapshot(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toProviderDefinitions(): ProviderToolDefinition[] {
    return this.snapshot().map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
  }
}