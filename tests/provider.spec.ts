import { describe, expect, it, vi } from 'vitest';

import { DeepSeekProvider } from '../src/llm/deepseek.js';

describe('DeepSeekProvider', () => {
  it('maps thinking config only through extra fields', () => {
    const provider = new DeepSeekProvider({ apiKey: 'test', model: 'deepseek-chat' });
    const body = provider.createRequestBody({
      model: 'deepseek-chat',
      messages: [{ id: 'u1', role: 'user', createdAt: new Date().toISOString(), content: 'hello' }],
      tools: [],
      signal: new AbortController().signal,
      extra: { thinking: { type: 'enabled' }, reasoning_effort: 'high', temperature: 0.2 },
    });

    expect(body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      temperature: 0.2,
    });
    expect(body).not.toHaveProperty('extra');
  });

  it('sends null assistant content when continuing tool calls without text', () => {
    const provider = new DeepSeekProvider({ apiKey: 'test', model: 'deepseek-chat' });
    const body = provider.createRequestBody({
      model: 'deepseek-chat',
      messages: [{
        id: 'a1',
        role: 'assistant',
        createdAt: new Date().toISOString(),
        content: '',
        toolCalls: [{
          id: 'call_1',
          name: 'read_file',
          input: { path: 'package.json' },
        }],
      }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(body).toMatchObject({
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'package.json' }),
          },
        }],
      }],
    });
  });

  it('preserves reasoning content for follow-up thinking requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          reasoning_content: 'step-by-step trace',
          tool_calls: [{
            id: 'call_1',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'package.json' }),
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const provider = new DeepSeekProvider({ apiKey: 'test', model: 'deepseek-v4-pro' });
      const response = await provider.generate({
        model: 'deepseek-v4-pro',
        messages: [{ id: 'u1', role: 'user', createdAt: new Date().toISOString(), content: 'hello' }],
        tools: [{
          name: 'read_file',
          description: 'read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        }],
        signal: new AbortController().signal,
        extra: { thinking: { type: 'enabled' } },
      });

      expect(response.assistant).toMatchObject({
        content: '',
        reasoningContent: 'step-by-step trace',
        toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'package.json' } }],
      });

      const replayBody = provider.createRequestBody({
        model: 'deepseek-v4-pro',
        messages: [response.assistant],
        tools: [],
        signal: new AbortController().signal,
        extra: { thinking: { type: 'enabled' } },
      });

      expect(replayBody).toMatchObject({
        messages: [{
          role: 'assistant',
          content: null,
          reasoning_content: 'step-by-step trace',
        }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses an injected token counter when available', () => {
    const tokenCounter = {
      countMessages: vi.fn().mockReturnValue(321),
      countText: vi.fn().mockReturnValue(0),
      describe: vi.fn().mockReturnValue({ source: 'deepseek_tokenizer', mode: 'exact' }),
    };
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-chat',
      tokenCounter,
    });
    const messages = [{ id: 'u1', role: 'user', createdAt: new Date().toISOString(), content: 'hello' }] as const;

    expect(provider.estimateTokens([...messages], { temperature: 0.2 })).toBe(321);
    expect(tokenCounter.countMessages).toHaveBeenCalledWith([...messages], { temperature: 0.2 });
    expect(provider.describeTokenEstimate?.()).toEqual({ source: 'deepseek_tokenizer', mode: 'exact' });
  });
});