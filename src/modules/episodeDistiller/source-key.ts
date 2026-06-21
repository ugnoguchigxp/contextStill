import { createHash } from "node:crypto";

export const EPISODE_DISTILLATION_VERSION = "episode-distiller-v1";

export type EpisodeGenerationKind = "task_episode" | "failure_episode" | "decision_episode";

export type EpisodeSourceSpan = {
  startOffset: number;
  endOffset: number;
};

export function episodeSourceFragmentHash(params: {
  parentSourceKind: "vibe_memory";
  parentSourceKey: string;
  sourceSpan: EpisodeSourceSpan;
  generationKind: EpisodeGenerationKind;
  distillationVersion: string;
}): string {
  return createHash("sha256")
    .update(
      [
        params.parentSourceKind,
        params.parentSourceKey,
        `${params.sourceSpan.startOffset}-${params.sourceSpan.endOffset}`,
        params.generationKind,
        params.distillationVersion,
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 12);
}

export function episodeSourceFragmentKey(params: {
  parentSourceKind: "vibe_memory";
  parentSourceKey: string;
  sourceSpan: EpisodeSourceSpan;
  generationKind: EpisodeGenerationKind;
  distillationVersion: string;
}): string {
  const fragmentHash = episodeSourceFragmentHash(params);
  return `${params.parentSourceKind}:${params.parentSourceKey}:episode:${fragmentHash}:${params.distillationVersion}`;
}
