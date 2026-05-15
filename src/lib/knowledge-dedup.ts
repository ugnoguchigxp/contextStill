/**
 * knowledge-dedup.ts
 *
 * MCP `register_knowledge` ツールと蒸留パイプラインで共用する
 * 知識アイテムの重複・類似検出ロジック。
 *
 * 判定フロー:
 *   1. ベクトル検索で候補 (top-K) を取得
 *   2. bigram 類似度 (Dice coefficient) でボディを比較
 *   3. タイトルの類似度でも補完比較
 *   4. いずれかが閾値を超えたら「重複あり」と判定
 */

import { embedOne } from "../modules/embedding/embedding.service.js";
import { vectorSearchKnowledge } from "../modules/knowledge/knowledge.repository.js";
import type { KnowledgeStatus } from "../shared/schemas/knowledge.schema.js";

export type DedupCandidate = {
  id: string;
  title: string;
  body: string;
  status: string;
  similarity: number;
};

export type DedupCheckResult =
  | { isDuplicate: true; existingId: string; matchScore: number; reason: string }
  | { isDuplicate: false };

/** テキストを bigram の Set に変換する */
function toBigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "").toLowerCase();
  const bigrams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Sorensen-Dice 係数 (0.0〜1.0) を返す。
 * 1.0 が完全一致。
 */
export function calculateBigramSimilarity(text1: string, text2: string): number {
  if (!text1 || !text2) return text1 === text2 ? 1 : 0;
  const s1 = text1.replace(/\s+/g, "").toLowerCase();
  const s2 = text2.replace(/\s+/g, "").toLowerCase();
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;

  const set1 = toBigrams(s1);
  const set2 = toBigrams(s2);

  let intersection = 0;
  for (const bg of set1) {
    if (set2.has(bg)) intersection++;
  }
  // Dice: 2|A∩B| / (|A| + |B|)
  return (2 * intersection) / (set1.size + set2.size);
}

export type DedupCheckOptions = {
  /** ベクトル検索で取得する候補数 (デフォルト: 5) */
  topK?: number;
  /**
   * ボディ bigram 類似度の重複判定閾値 (デフォルト: 0.92)
   * MCP では 0.95 を使っているが、蒸留では少し緩めに設定
   */
  bodySimilarityThreshold?: number;
  /**
   * タイトル bigram 類似度の補完閾値 (デフォルト: 0.90)
   * ボディが短い場合にタイトルでも判定する
   */
  titleSimilarityThreshold?: number;
  /** 重複判定対象のステータス */
  statuses?: KnowledgeStatus[];
  /** 既に取得済みの embedding (省略時は自動生成) */
  embedding?: number[];
};

/**
 * 指定したタイトル・ボディが既存 knowledge と重複するか判定する。
 *
 * - embedding が利用可能な場合: ベクトル検索 → bigram 比較
 * - embedding が利用不可な場合: `isDuplicate: false` を返す（挿入を許可）
 *
 * @returns DedupCheckResult
 */
export async function checkKnowledgeDuplicate(
  title: string,
  body: string,
  options: DedupCheckOptions = {},
): Promise<DedupCheckResult> {
  const topK = options.topK ?? 5;
  const bodySimilarityThreshold = options.bodySimilarityThreshold ?? 0.92;
  const titleSimilarityThreshold = options.titleSimilarityThreshold ?? 0.9;
  const statuses: KnowledgeStatus[] = options.statuses ?? ["active", "draft", "deprecated"];

  let embedding = options.embedding;
  if (!embedding || embedding.length === 0) {
    try {
      embedding = await embedOne(`${title}\n${body}`, "passage");
    } catch {
      // embedding が取得できない場合は重複チェックをスキップ
      return { isDuplicate: false };
    }
  }
  if (!embedding || embedding.length === 0) {
    return { isDuplicate: false };
  }

  let candidates: Awaited<ReturnType<typeof vectorSearchKnowledge>>;
  try {
    candidates = await vectorSearchKnowledge(embedding, topK, statuses);
  } catch {
    return { isDuplicate: false };
  }

  for (const candidate of candidates) {
    const bodySimilarity = calculateBigramSimilarity(body, candidate.body);
    if (bodySimilarity >= bodySimilarityThreshold) {
      return {
        isDuplicate: true,
        existingId: candidate.id,
        matchScore: bodySimilarity,
        reason: `body_bigram:${bodySimilarity.toFixed(3)}`,
      };
    }

    // ボディが短い（200文字未満）場合はタイトルでも補完判定
    if (body.length < 200) {
      const titleSimilarity = calculateBigramSimilarity(title, candidate.title);
      if (titleSimilarity >= titleSimilarityThreshold && bodySimilarity >= 0.7) {
        return {
          isDuplicate: true,
          existingId: candidate.id,
          matchScore: (titleSimilarity + bodySimilarity) / 2,
          reason: `title_bigram:${titleSimilarity.toFixed(3)}+body:${bodySimilarity.toFixed(3)}`,
        };
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * 名寄せ候補を返す（重複判定より緩い閾値で類似アイテムを列挙）。
 * 管理 UI や `dedup:knowledge` コマンドから利用する想定。
 *
 * @param title - 比較元タイトル
 * @param body  - 比較元ボディ
 * @param options
 */
export async function findSimilarKnowledge(
  title: string,
  body: string,
  options: { topK?: number; minSimilarity?: number; embedding?: number[] } = {},
): Promise<DedupCandidate[]> {
  const topK = options.topK ?? 10;
  const minSimilarity = options.minSimilarity ?? 0.7;

  let embedding = options.embedding;
  if (!embedding || embedding.length === 0) {
    try {
      embedding = await embedOne(`${title}\n${body}`, "passage");
    } catch {
      return [];
    }
  }
  if (!embedding || embedding.length === 0) {
    return [];
  }

  let candidates: Awaited<ReturnType<typeof vectorSearchKnowledge>>;
  try {
    candidates = await vectorSearchKnowledge(embedding, topK, ["active", "draft", "deprecated"]);
  } catch {
    return [];
  }

  return candidates
    .map((c) => {
      const bodySim = calculateBigramSimilarity(body, c.body);
      const titleSim = calculateBigramSimilarity(title, c.title);
      const similarity = Math.max(bodySim, titleSim * 0.6 + bodySim * 0.4);
      return { id: c.id, title: c.title, body: c.body, status: c.status, similarity };
    })
    .filter((c) => c.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);
}
