import { z } from "zod";

export const larmAudienceSchema = z.enum(["same-host", "saaa-desktop"]);

const larmFields = {
	baseUrl: z.string().min(1).max(2048).nullable(),
	audience: larmAudienceSchema.nullable(),
	embeddingProfile: z.string().min(1).max(64),
	llmProfile: z.string().min(1).max(64),
};

/**
 * The LARM connection. `baseUrl` is the origin of the LARM control API (null: not configured).
 * A stored document without `llmProfile` (written before N2) reads with the default.
 */
export const larmSettingsSchema = z
	.object({
		...larmFields,
		llmProfile: larmFields.llmProfile.default("contextStill"),
	})
	.strict();

export const settingsSchema = z
	.object({
		revision: z.number().int().min(0),
		larm: larmSettingsSchema,
	})
	.strict();
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
	revision: 0,
	larm: {
		baseUrl: null,
		audience: null,
		embeddingProfile: "embeddingCanary",
		llmProfile: "contextStill",
	},
};

// Built from the fields without the default: a missing key in a patch must stay missing.
export const larmPatchSchema = z.object(larmFields).strict().partial();
export type LarmPatch = z.infer<typeof larmPatchSchema>;

/** PUT /api/settings/larm */
export const putLarmBodySchema = z
	.object({ baseUrl: z.string().max(2048).nullable() })
	.strict();

/** Credential ids are fixed names, never user text. */
export const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export type SettingsKeyError = "secret_key_unavailable" | "secret_key_invalid";

/** Facts about the settings store. Never contains a secret value. */
export interface SettingsDiagnostics {
	version: 1;
	revision: number;
	keyError: SettingsKeyError | null;
	keySource: "env" | "file" | null;
	credentialCount: number;
}

export const errorStatus = {
	invalid_larm_settings: 400,
	invalid_credential_id: 400,
	secret_key_unavailable: 503,
	secret_key_invalid: 503,
} as const;
