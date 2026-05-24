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

export function parseWebIngestTargetMetadata(
  value: unknown,
): z.infer<typeof webIngestTargetMetadataSchema> {
  const parsed = webIngestTargetMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
