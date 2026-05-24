import { z } from "zod";

export const landscapeSnapshotCacheTypeSchema = z.enum([
  "landscape_snapshot",
  "landscape_replay_snapshot",
  "landscape_replay_comparison",
]);

export const landscapeSnapshotCacheStatusSchema = z.object({
  generatedAt: z.string().datetime(),
  enabled: z.boolean(),
  ttlSeconds: z.number().int().positive(),
  snapshots: z.array(
    z.object({
      snapshotType: landscapeSnapshotCacheTypeSchema,
      readyCount: z.number().int().nonnegative(),
      staleCount: z.number().int().nonnegative(),
      latestGeneratedAt: z.string().datetime().nullable(),
      latestExpiresAt: z.string().datetime().nullable(),
    }),
  ),
});

export type LandscapeSnapshotCacheStatus = z.infer<typeof landscapeSnapshotCacheStatusSchema>;
