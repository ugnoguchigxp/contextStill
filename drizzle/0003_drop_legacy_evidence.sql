DO $$
BEGIN
  IF to_regclass('public.evidence_sources') IS NOT NULL THEN
    INSERT INTO "sources" (
      "source_kind",
      "uri",
      "title",
      "body",
      "content_hash",
      "metadata",
      "created_at",
      "updated_at"
    )
    SELECT
      es."source_kind",
      es."uri",
      es."title",
      COALESCE(
        NULLIF(string_agg(ef."content", E'\n\n' ORDER BY ef."created_at"), ''),
        es."title",
        es."uri"
      ) AS "body",
      es."content_hash",
      es."metadata" || '{"legacyTable":"evidence_sources"}'::jsonb,
      es."created_at",
      es."updated_at"
    FROM "evidence_sources" es
    LEFT JOIN "evidence_fragments" ef ON ef."source_id" = es."id"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "sources" s
      WHERE s."uri" = es."uri"
        AND s."content_hash" = es."content_hash"
    )
    GROUP BY
      es."id",
      es."source_kind",
      es."uri",
      es."title",
      es."content_hash",
      es."metadata",
      es."created_at",
      es."updated_at";
  END IF;

  IF to_regclass('public.evidence_sources') IS NOT NULL
    AND to_regclass('public.evidence_fragments') IS NOT NULL THEN
    INSERT INTO "source_fragments" (
      "source_id",
      "locator",
      "heading",
      "content",
      "embedding",
      "metadata",
      "created_at"
    )
    SELECT
      s."id",
      ef."locator",
      NULL,
      ef."content",
      ef."embedding",
      ef."metadata" || '{"legacyTable":"evidence_fragments"}'::jsonb,
      ef."created_at"
    FROM "evidence_fragments" ef
    INNER JOIN "evidence_sources" es ON es."id" = ef."source_id"
    INNER JOIN "sources" s
      ON s."uri" = es."uri"
      AND s."content_hash" = es."content_hash"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "source_fragments" sf
      WHERE sf."source_id" = s."id"
        AND sf."locator" = ef."locator"
        AND sf."content" = ef."content"
    );
  END IF;
END $$;

ALTER TABLE IF EXISTS "context_pack_items"
  ADD COLUMN IF NOT EXISTS "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'context_pack_items'
      AND column_name = 'evidence_refs'
  ) THEN
    UPDATE "context_pack_items"
    SET "source_refs" = "evidence_refs"
    WHERE "source_refs" = '[]'::jsonb;

    ALTER TABLE "context_pack_items"
      DROP COLUMN "evidence_refs";
  END IF;
END $$;

UPDATE "context_pack_items"
SET "section" = 'warnings'
WHERE "section" = 'evidence';

ALTER TABLE IF EXISTS "context_pack_items"
  DROP CONSTRAINT IF EXISTS "context_pack_items_section_check";

ALTER TABLE IF EXISTS "context_pack_items"
  ADD CONSTRAINT "context_pack_items_section_check"
  CHECK ("section" IN ('rules','skills','examples','code_context','warnings'));

DROP TABLE IF EXISTS "evidence_fragments" CASCADE;
DROP TABLE IF EXISTS "evidence_sources" CASCADE;
