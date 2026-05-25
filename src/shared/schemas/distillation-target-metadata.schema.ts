import { z } from "zod";

export const webIngestTargetMetadataSchema = z
  .object({
    sourceUrl: z.string().trim().min(1).optional(),
    sourceWebUrl: z.string().trim().min(1).optional(),
    savedWikiTargetKey: z.string().trim().min(1).optional(),
    savedWikiSlug: z.string().trim().min(1).optional(),
    savedWikiPath: z.string().trim().min(1).optional(),
    researchGeneratedAt: z.string().trim().min(1).optional(),
    llmProvider: z.string().trim().min(1).optional(),
    llmModel: z.string().trim().min(1).optional(),
    fetchFinalUrl: z.string().trim().min(1).optional(),
  })
  .passthrough();

export const coverEvidenceReprocessRequestSchema = z
  .object({
    mode: z.enum(["cloud_api"]),
    requestedAt: z.string().trim().min(1),
    requestedBy: z.enum(["user", "system"]).optional(),
    findCandidateResultIds: z.array(z.string().trim().min(1)).default([]),
    coverEvidenceResultIds: z.array(z.string().trim().min(1)).default([]),
    forceRefreshEvidence: z.boolean().optional(),
    providerPolicy: z.enum(["cloud_api"]).optional(),
    providerFallbackMode: z.enum(["fallback", "single"]).optional(),
    status: z.enum(["requested", "completed"]).default("requested"),
    completedAt: z.string().trim().min(1).optional(),
  })
  .passthrough();

export function parseWebIngestTargetMetadata(
  value: unknown,
): z.infer<typeof webIngestTargetMetadataSchema> {
  const parsed = webIngestTargetMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function parseCoverEvidenceReprocessRequest(
  value: unknown,
): z.infer<typeof coverEvidenceReprocessRequestSchema> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as { coverEvidenceReprocessRequest?: unknown })
    .coverEvidenceReprocessRequest;
  const parsed = coverEvidenceReprocessRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
