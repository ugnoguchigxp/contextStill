import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    "team-id": { type: "string" },
    "launch-agent-plist": { type: "string" },
  },
  strict: true,
});
const issues = [];
const checks = {};
function command(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function check(name, ok) {
  checks[name] = Boolean(ok);
  if (!ok) issues.push(name);
}
let binary;
try {
  check("macos", process.platform === "darwin");
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  if (!values.binary) throw new Error("binary_argument_required");
  binary = await realpath(path.resolve(values.binary));
  const expectedTeam = values["team-id"];
  check("expected_team_configured", /^[A-Z0-9]{10}$/.test(expectedTeam ?? ""));
  const signature = command("codesign", ["-d", "--verbose=4", binary]);
  const team = signature.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  check("signature_valid", command("codesign", ["--verify", "--strict", "--verbose=2", binary]).ok);
  check(
    "developer_id_signature",
    signature.ok && /^Authority=Developer ID Application:/m.test(signature.stderr),
  );
  check("team_matches", Boolean(expectedTeam && team === expectedTeam));
  check("hardened_runtime", /flags=.*\(.*runtime.*\)/.test(signature.stderr));
  check("secure_timestamp", /^Timestamp=/m.test(signature.stderr));
  // Gatekeeper assesses the actual artifact, rather than treating any local signature as trusted.
  check(
    "gatekeeper_accepted",
    command("spctl", ["--assess", "--type", "execute", "--verbose=4", binary]).ok,
  );
  const plistPath = values["launch-agent-plist"];
  check("launch_agent_specified", Boolean(plistPath));
  if (plistPath) {
    const parsed = command("plutil", ["-convert", "json", "-o", "-", path.resolve(plistPath)]);
    if (!parsed.ok) throw new Error("launch_agent_plist_unreadable");
    const plist = JSON.parse(parsed.stdout);
    if (!/^[A-Za-z0-9.-]+$/.test(plist.Label ?? "")) throw new Error("launch_agent_label_invalid");
    const configuredBinary = plist.Program ?? plist.ProgramArguments?.[0];
    check(
      "launch_binary_matches",
      typeof configuredBinary === "string" &&
        (await realpath(configuredBinary).catch(() => null)) === binary,
    );
    const uid = process.getuid();
    const service = command("launchctl", ["print", `gui/${uid}/${plist.Label}`]);
    const pid = service.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    check("launch_agent_running", service.ok && Boolean(pid));
    if (pid) {
      const user = command("ps", ["-p", pid, "-o", "uid="]);
      const executable = command("ps", ["-ww", "-p", pid, "-o", "comm="]);
      check("launch_user_matches", user.ok && Number(user.stdout.trim()) === uid);
      check(
        "running_binary_matches",
        executable.ok && (await realpath(executable.stdout.trim()).catch(() => null)) === binary,
      );
    }
  }
} catch (error) {
  // Do not include codesign/launchctl output or plist EnvironmentVariables in reports.
  issues.push(
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "preflight_inspection_failed",
  );
}
console.log(
  JSON.stringify(
    {
      ok: issues.length === 0,
      binary,
      checks,
      issues,
      releaseEligible: false,
      remainingAcceptance: ["Keychain access under the signed launch identity", "release review"],
    },
    null,
    2,
  ),
);
if (issues.length) process.exitCode = 1;
