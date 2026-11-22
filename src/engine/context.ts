export const defaultChatContextWindow = 4_096;

export function conversationTokenBudget(contextWindow = defaultChatContextWindow): number {
  return Math.floor(contextWindow / 2);
}

export function estimateMessageTokens(modelJson: string): number {
  // UTF-8 bytes account for script differences. Allow extra room for chat framing.
  return Math.ceil(Buffer.byteLength(modelJson, "utf8") / 3) + 8;
}
