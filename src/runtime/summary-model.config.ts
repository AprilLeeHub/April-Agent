/**
 * Summary: Default small-model summary configuration used to condense older
 * closed context before the main model consumes it.
 */

import type { SummaryModelConfig } from '../types/index.js';

export const smallModelSummaryConfig: SummaryModelConfig = {
  model: 'deepseek-chat',
  triggerRatio: 0.65,
  hysteresis: 0.1,
  maxSourceMessages: 40,
  systemPrompt: [
    'Summarize earlier closed agent context for a coding agent.',
    'Return 4-8 short bullets.',
    'Preserve user intent, tool outputs, files, approvals, artifactIds, and unresolved constraints.',
    'Do not invent facts.',
  ].join(' '),
  extra: {
    temperature: 0.1,
    max_tokens: 256,
  },
};

export default smallModelSummaryConfig;