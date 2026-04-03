export const TOKEN_SOFT_CAP = 1500;
export const PENALTY_PER_TOKEN = 0.0001;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function effectiveScore(avgScore: number, promptText: string): number {
  const tokens = estimateTokens(promptText);
  const penalty = Math.max(0, (tokens - TOKEN_SOFT_CAP) * PENALTY_PER_TOKEN);
  return avgScore - penalty;
}
