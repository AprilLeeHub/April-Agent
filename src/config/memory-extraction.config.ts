/**
 * Summary: Model configuration specifically tuned for extracting episodic 
 * memory from turn checkpoints. Uses a fast model to distill decision events 
 * and tool receipts.
 */

import type { SummaryModelConfig } from '../types/index.js';

export const memoryExtractionConfig: SummaryModelConfig = {
  model: 'deepseek-v4-flash',
  maxSourceMessages: 30, // Turn limit coverage
  systemPrompt: [
    'You are a specialized agent memory extractor.',
    'Review the decision events and tool receipts from the just-finished turn.',
    'Extract a concise episodic memory highlighting: user intent, actions taken, blockers encountered, and key discoveries or file paths.',
    'Format as 3-5 concise bullets.',
    'Focus on durable knowledge that might be useful for future tasks.',
  ].join(' '),
  extra: {
    temperature: 0.1,
  },
};
