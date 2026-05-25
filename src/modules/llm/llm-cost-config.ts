export type CostRate = {
  inputJpyPerM: number;
  outputJpyPerM: number;
};

// 100万トークンあたりの日本円（JPY）単価（1ドル = 150円換算ベースの代表値）
export const LLM_COST_RATES: Record<string, CostRate> = {
  "gpt-4o": { inputJpyPerM: 375, outputJpyPerM: 1500 },
  "5.4mini": { inputJpyPerM: 112.5, outputJpyPerM: 675 },
  "5.4-mini": { inputJpyPerM: 112.5, outputJpyPerM: 675 },
  "gpt-5-4-mini": { inputJpyPerM: 112.5, outputJpyPerM: 675 },
  "gpt-5.4-mini": { inputJpyPerM: 112.5, outputJpyPerM: 675 },
  "5.4nano": { inputJpyPerM: 30, outputJpyPerM: 187.5 },
  "5.4-nano": { inputJpyPerM: 30, outputJpyPerM: 187.5 },
  "gpt-5-4-nano": { inputJpyPerM: 30, outputJpyPerM: 187.5 },
  "gpt-5.4-nano": { inputJpyPerM: 30, outputJpyPerM: 187.5 },
  "claude-haiku-4-5": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "claude-4-5-haiku": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "haiku-4.5": { inputJpyPerM: 150, outputJpyPerM: 750 },
  // Claude Haiku 4.6 は公式価格未確認のため、4.5 と同額で暫定エイリアスを保持。
  "claude-haiku-4-6": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "claude-4-6-haiku": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "claude-4.6-haiku": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "haiku-4.6": { inputJpyPerM: 150, outputJpyPerM: 750 },
  "o3-mini": { inputJpyPerM: 165, outputJpyPerM: 660 },
  "o1-mini": { inputJpyPerM: 450, outputJpyPerM: 1800 },
  "o1-preview": { inputJpyPerM: 2250, outputJpyPerM: 9000 },
  "local-llm": { inputJpyPerM: 0, outputJpyPerM: 0 },
  "gemma-4-e4b-it": { inputJpyPerM: 0, outputJpyPerM: 0 },
  "default-cloud": { inputJpyPerM: 400, outputJpyPerM: 1600 },
};

export function resolveCostRate(model: string): CostRate {
  const normalized = model.toLowerCase().trim();

  for (const key of Object.keys(LLM_COST_RATES)) {
    if (normalized.includes(key.toLowerCase())) {
      return LLM_COST_RATES[key];
    }
  }

  return LLM_COST_RATES["default-cloud"];
}

/**
 * モデル名と入力/出力トークン数に基づいて日本円コストを計算します。
 * @param model モデル名またはプロバイダー名
 * @param promptTokens 入力トークン数
 * @param completionTokens 出力トークン数
 * @returns 算出された日本円コスト（円）
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = resolveCostRate(model);

  const inputCost = (promptTokens / 1_000_000) * rate.inputJpyPerM;
  const outputCost = (completionTokens / 1_000_000) * rate.outputJpyPerM;

  return Number((inputCost + outputCost).toFixed(4));
}
