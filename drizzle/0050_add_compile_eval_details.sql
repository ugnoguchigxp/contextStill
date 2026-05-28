ALTER TABLE "context_compile_evals" ADD COLUMN "relevance" integer;
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "actionability" integer;
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "coverage" integer;
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "noise" integer;
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "specificity" integer;
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_relevance_range_check" CHECK ("relevance" is null or ("relevance" >= 0 and "relevance" <= 100));
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_actionability_range_check" CHECK ("actionability" is null or ("actionability" >= 0 and "actionability" <= 100));
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_coverage_range_check" CHECK ("coverage" is null or ("coverage" >= 0 and "coverage" <= 100));
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_noise_range_check" CHECK ("noise" is null or ("noise" >= 0 and "noise" <= 100));
--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_specificity_range_check" CHECK ("specificity" is null or ("specificity" >= 0 and "specificity" <= 100));
