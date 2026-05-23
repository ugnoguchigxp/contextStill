CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_kind" text DEFAULT 'json' NOT NULL,
	"secret_ref" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"description" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "settings_value_kind_check" CHECK ("settings"."value_kind" IN ('json', 'string', 'secret_ref', 'encrypted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "settings_namespace_key_unique_idx" ON "settings" USING btree ("namespace","key");
--> statement-breakpoint
CREATE INDEX "settings_namespace_idx" ON "settings" USING btree ("namespace");
--> statement-breakpoint
CREATE INDEX "settings_key_idx" ON "settings" USING btree ("key");
