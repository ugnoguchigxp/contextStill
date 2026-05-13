type Rankable = {
  id: string;
  title: string;
  content: string;
  score: number;
  confidence?: number;
  importance?: number;
};

export function rankAndDedupe<T extends Rankable>(items: T[], limit: number): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const existing = byId.get(item.id);
    const currentScore = item.score + (item.importance ?? 0) * 0.2 + (item.confidence ?? 0) * 0.1;
    const existingScore =
      (existing?.score ?? Number.NEGATIVE_INFINITY) +
      (existing?.importance ?? 0) * 0.2 +
      (existing?.confidence ?? 0) * 0.1;
    if (!existing || currentScore > existingScore) {
      byId.set(item.id, item);
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
