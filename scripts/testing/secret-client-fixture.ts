import { saveSecretUpdate } from "../../src/modules/settings/settings-secret.service.js";
import {
  SETTINGS_SECRET_NAMESPACE,
  findSettingsRow,
} from "../../src/modules/settings/settings.repository.js";
const value = process.env.CONTEXT_STILL_SYNTHETIC_TEST_SECRET;
if (!value?.startsWith("contextstill-synthetic-secret-acceptance-"))
  throw new Error("synthetic fixture required");
await saveSecretUpdate("openaiApiKey", { value }, "isolated-test");
const row = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
if (!row?.secretRef) throw new Error("reference missing");
console.log(JSON.stringify({ reference: row.secretRef }));
