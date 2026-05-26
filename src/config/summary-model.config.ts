/*
 * @Author: leeTing april.lee0828@gmail.com
 * @Date: 2026-04-27 10:48:28
 * @LastEditors: leeTing april.lee0828@gmail.com
 * @LastEditTime: 2026-05-26 10:40:17
 * @FilePath: /april-agent/src/runtime/summary-model.config.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * Summary: Default small-model summary configuration used to condense older
 * closed context before the main model consumes it.
 */

import type { SummaryModelConfig } from '../types/index.js';

export const smallModelSummaryConfig: SummaryModelConfig = {
  model: 'deepseek-v4-flash',
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