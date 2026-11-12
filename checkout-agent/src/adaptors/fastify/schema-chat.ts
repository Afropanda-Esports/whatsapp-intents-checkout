import { z } from 'zod';

export const chatRequestBody = z
  .object({
    conversationId: z.string().min(1).max(80),
    text: z.string().min(1).max(500),
  })
  .strict();
