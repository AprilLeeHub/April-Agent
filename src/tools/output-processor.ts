/**
 * Summary: Output governance for tool results, including summarization,
 * truncation, and artifact offloading.
 */

import type { ArtifactStore } from '../storage/artifact-store.js';
import type { JsonValue, SandboxConstraints, ToolDefinition, ToolOutputProcessingResult, ToolOutputProcessor } from '../types/index.js';
import { summarizeText } from './tool-utils.js';

export const TOOL_OUTPUT_LIMITS: Record<NonNullable<ToolDefinition['outputKind']>, number> = {
  'read-file': 20_000,
  search: 10_000,
  shell: 15_000,
  default: 12_000,
};

export class DefaultToolOutputProcessor implements ToolOutputProcessor {
  constructor(private readonly artifactStore: ArtifactStore) {}

  async process(
    tool: ToolDefinition,
    text: string,
    input: { sandbox?: SandboxConstraints } = {},
  ): Promise<ToolOutputProcessingResult> {
    const limit = input.sandbox?.maxOutputChars ?? TOOL_OUTPUT_LIMITS[tool.outputKind ?? 'default'];
    if (text.length <= limit) {
      return {
        text,
        summary: summarizeText(text),
        truncated: false,
      };
    }

    const artifact = await this.artifactStore.write({
      toolName: tool.name,
      content: text,
      metadata: {
        limit,
        outputKind: tool.outputKind ?? 'default',
        originalLength: text.length,
      },
    });

    const summary = summarizeText(text);
    return {
      text: `Output truncated. Artifact ${artifact.id} stores the full ${tool.name} result. ${summary}`,
      summary,
      truncated: true,
      artifactId: artifact.id,
      metadata: {
        limit,
        originalLength: text.length,
        outputKind: tool.outputKind ?? 'default',
      } satisfies Record<string, JsonValue>,
    };
  }
}