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
  disabledReason: z.string().nullable().optional(),
  snapshots: z.array(
    z.object({
      snapshotType: landscapeSnapshotCacheTypeSchema,
      readyCount: z.number().int().nonnegative(),
      staleCount: z.number().int().nonnegative(),
      expiredReadyCount: z.number().int().nonnegative(),
      oldestGeneratedAt: z.string().datetime().nullable(),
      latestGeneratedAt: z.string().datetime().nullable(),
      latestExpiresAt: z.string().datetime().nullable(),
      estimatedPayloadBytes: z.number().int().nonnegative(),
      lastPurge: z
        .object({
          purgedAt: z.string().datetime(),
          staleDeletedCount: z.number().int().nonnegative(),
          expiredDeletedCount: z.number().int().nonnegative(),
          deletedCount: z.number().int().nonnegative(),
          snapshotTypes: z.array(landscapeSnapshotCacheTypeSchema),
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});

export type LandscapeSnapshotCacheStatus = z.infer<typeof landscapeSnapshotCacheStatusSchema>;
