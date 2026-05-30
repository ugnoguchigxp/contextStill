ALTER TABLE "context_compile_evals" RENAME COLUMN "noise" TO "clarity";
ALTER TABLE "context_compile_evals" DROP CONSTRAINT "context_compile_evals_noise_range_check";
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_clarity_range_check" CHECK ("clarity" is null or ("clarity" >= 0 and "clarity" <= 100));