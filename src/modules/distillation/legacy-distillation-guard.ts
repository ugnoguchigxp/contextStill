import { groupedConfig } from "../../config.js";

export class LegacyDistillationDisabledError extends Error {
  constructor(context: string) {
    super(
      `Legacy distillation is disabled (${context}). Enable APP_CONSTANTS.distillationLegacyEnabled only while migrating to domain-based distillation.`,
    );
    this.name = "LegacyDistillationDisabledError";
  }
}

export function assertLegacyDistillationEnabled(context: string): void {
  if (groupedConfig.distillation.legacyEnabled) return;
  throw new LegacyDistillationDisabledError(context);
}
