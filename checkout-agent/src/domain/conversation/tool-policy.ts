import { classifyMessage } from './classify-message.js';
import type { ToolCall } from './types.js';

const FORBIDDEN_KEYS = new Set([
  'destination',
  'destinations',
  'payee',
  'payees',
  'refundaddress',
  'refundto',
  'refunddestination',
  'account',
  'accountid',
]);

export type ToolRefusal = {
  conversationId: string;
  tool: string;
  reason: string;
};

export type ToolAllowance = { ok: true } | { ok: false; reason: string };

export type ToolPolicy = {
  assess(input: { conversationId: string; call: ToolCall; userText: string }): ToolAllowance;
  refusals(): readonly ToolRefusal[];
};

export function createToolPolicy(): ToolPolicy {
  const recorded: ToolRefusal[] = [];
  return {
    assess(input) {
      const decision = decide(input.call, input.userText);
      if (!decision.ok) {
        recorded.push({ conversationId: input.conversationId, tool: input.call.name, reason: decision.reason });
      }
      return decision;
    },
    refusals() {
      return recorded;
    },
  };
}

function decide(call: ToolCall, userText: string): ToolAllowance {
  const intent = classifyMessage(userText);
  if (intent.kind === 'refund' || intent.kind === 'payout') {
    return { ok: false, reason: 'user-supplied-destination' };
  }
  const key = forbiddenKey(call.arguments) ?? forbiddenValue(call.arguments, userText);
  if (key !== undefined) return { ok: false, reason: `user-supplied-destination:${key}` };
  return { ok: true };
}

function forbiddenKey(args: Readonly<Record<string, string>>): string | undefined {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) return key;
  }
  return undefined;
}

function forbiddenValue(args: Readonly<Record<string, string>>, userText: string): string | undefined {
  const tokens = suppliedTokens(userText);
  if (tokens.length === 0) return undefined;
  for (const [key, value] of Object.entries(args)) {
    const haystack = value.toLowerCase();
    if (tokens.some((token) => haystack.includes(token))) return key;
  }
  return undefined;
}

function suppliedTokens(userText: string): string[] {
  const tokens: string[] = [];
  for (const match of userText.matchAll(/\b(?:address|account|payee|destination)\s+([A-Za-z0-9:._-]{3,})/giu)) {
    const token = match[1];
    if (token !== undefined) tokens.push(token.toLowerCase());
  }
  return tokens;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, '');
}
