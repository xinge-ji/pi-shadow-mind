export interface ToolResultName {
  toolName?: string;
}

/** Return the highest configured weight among the tools completed in one Main turn. */
export function calculateTurnWeight(
  toolResults: readonly ToolResultName[],
  weights: Readonly<Record<string, number>>,
): number {
  let highest = 0;
  const fallback = weights.default ?? 1;
  for (const result of toolResults) {
    const weight = weights[result.toolName ?? ""] ?? fallback;
    highest = Math.max(highest, weight);
  }
  return highest;
}
