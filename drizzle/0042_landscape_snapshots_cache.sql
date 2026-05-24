CREATE TABLE IF NOT EXISTS "landscape_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ready',
  "params_hash" text NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "landscape_snapshots_status_check"
    CHECK ("status" IN ('ready', 'stale')),
  CONSTRAINT "landscape_snapshots_type_check"
    CHECK ("snapshot_type" IN (
      'landscape_snapshot',
      'landscape_replay_snapshot',
      'landscape_replay_comparison'
    )),
  CONSTRAINT "landscape_snapshots_params_object_check"
    CHECK (jsonb_typeof("params") = 'object'),
  CONSTRAINT "landscape_snapshots_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "landscape_snapshots_type_params_hash_unique"
  ON "landscape_snapshots" ("snapshot_type", "params_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_snapshots_type_generated_at_idx"
  ON "landscape_snapshots" ("snapshot_type", "generated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_snapshots_expires_at_idx"
  ON "landscape_snapshots" ("expires_at");
