import { TOOL_NAMES, type ToolCall, type ToolName } from '../../domain/conversation/types.js';
import type { LanguageModel } from '../../ports/outbound/language-model.js';

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Thin translator for an OpenAI-compatible chat completion.
 * The purchase suite uses the scripted model and does not call this.
 */
export function createOpenAiCompatibleLanguageModel(options: OpenAiCompatibleOptions): LanguageModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async nextStep(request) {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
      };
      if (options.apiKey !== undefined) headers['authorization'] = `Bearer ${options.apiKey}`;
      let response: Response;
      try {
        response = await fetchImpl(new URL('/v1/chat/completions', options.baseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: 'user', content: request.text }],
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return { kind: 'reply' };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { kind: 'reply' };
      }
      const call = decodeToolCall(payload);
      if (call === undefined) return { kind: 'reply' };
      return { kind: 'tool', call };
    },
  };
}

function decodeToolCall(payload: unknown): ToolCall | undefined {
  if (typeof payload !== 'object' || payload === null || !('choices' in payload) || !Array.isArray(payload.choices)) {
    return undefined;
  }
  const choice = payload.choices[0];
  if (typeof choice !== 'object' || choice === null || !('message' in choice)) return undefined;
  const message = choice.message;
  if (typeof message !== 'object' || message === null || !('tool_calls' in message) || !Array.isArray(message.tool_calls)) {
    return undefined;
  }
  const toolCall = message.tool_calls[0];
  if (typeof toolCall !== 'object' || toolCall === null || !('function' in toolCall)) return undefined;
  const fn = toolCall.function;
  if (typeof fn !== 'object' || fn === null || !('name' in fn) || typeof fn.name !== 'string' || !isToolName(fn.name)) {
    return undefined;
  }
  if (!('arguments' in fn) || typeof fn.arguments !== 'string') return undefined;
  const args = decodeArguments(fn.arguments);
  if (args === undefined) return undefined;
  return { name: fn.name, arguments: args };
}

function decodeArguments(raw: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return undefined;
    args[key] = value;
  }
  return args;
}

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
