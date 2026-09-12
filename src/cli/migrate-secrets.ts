import {
  migrateLegacySecrets,
  saveSecretUpdate,
} from "../modules/settings/settings-secret.service.js";
import {
  SETTINGS_SECRET_NAMESPACE,
  listSettingsRows,
} from "../modules/settings/settings.repository.js";

const args = process.argv.slice(2);
if (
  args.length === 2 &&
  args[0] === "--use-environment" &&
  /^[a-zA-Z][a-zA-Z0-9]{0,99}$/.test(args[1] ?? "")
) {
  try {
    await saveSecretUpdate(args[1] ?? "", { useEnvironment: true }, "secret-recovery");
    console.log(JSON.stringify({ environmentEnabled: true }));
  } catch {
    console.error(
      "Secret recovery incomplete; retry after the resident and secret store are available.",
    );
    process.exitCode = 1;
  }
} else if (args.length !== 1 || !["--dry-run", "--write"].includes(args[0] ?? "")) {
  console.error("Usage: bun src/cli/migrate-secrets.ts --dry-run|--write|--use-environment KEY");
  process.exitCode = 1;
} else {
  try {
    if (args[0] === "--write") console.log(JSON.stringify(await migrateLegacySecrets()));
    else {
      const rows = await listSettingsRows(SETTINGS_SECRET_NAMESPACE);
      console.log(
        JSON.stringify({
          legacy: rows.filter((row) => row.valueKind !== "secret_ref").map((row) => row.key),
        }),
      );
    }
  } catch {
    console.error(
      "Secret migration incomplete; some keys may already be migrated. Resolve secret-store availability and retry.",
    );
    process.exitCode = 1;
  }
}
