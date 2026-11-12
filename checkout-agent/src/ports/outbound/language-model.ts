import type { ModelKnown, ModelStep, ToolResult } from '../../domain/conversation/types.js';

export type ModelRequest = {
  conversationId: string;
  text: string;
  toolResults: readonly ToolResult[];
  known: ModelKnown;
};

export type LanguageModel = {
  nextStep(request: ModelRequest): Promise<ModelStep>;
};
