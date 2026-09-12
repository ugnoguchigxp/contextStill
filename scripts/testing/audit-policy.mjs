export function classifyAudit(tool, execution, exceptions = [], now = new Date()) {
  const expired = exceptions.filter(
    (e) =>
      !e.id ||
      !e.reason ||
      !e.owner ||
      !Number.isFinite(Date.parse(e.expires)) ||
      Date.parse(e.expires) <= now.getTime(),
  );
  if (expired.length)
    return { status: "unavailable", reason: "invalid_or_expired_exception", fail: true };
  if (execution.signal || execution.error || ![0, 1].includes(execution.code))
    return { status: "unavailable", reason: "process_failed_or_timed_out", fail: true };
  let payload;
  try {
    payload = JSON.parse(execution.stdout);
  } catch {
    return { status: "unavailable", reason: "invalid_report", fail: true };
  }
  let advisories;
  if (tool === "cargo") {
    if (!Array.isArray(payload.vulnerabilities?.list) || !payload.database?.["last-commit"])
      return { status: "unavailable", reason: "missing_advisory_database", fail: true };
    advisories = payload.vulnerabilities.list.map((v) => ({
      id: v.advisory.id,
      severity: "unknown",
    }));
    // RustSec has CVSS vectors rather than npm severity labels. Fail all findings conservatively.
  } else {
    const map = payload.advisories ?? payload;
    if (!map || typeof map !== "object" || Array.isArray(map))
      return { status: "unavailable", reason: "invalid_advisories", fail: true };
    advisories = Object.values(map)
      .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
      .map((v) => ({ id: String(v.id ?? v.cves?.[0] ?? v.url ?? ""), severity: v.severity }));
    if (
      advisories.some((v) => !v.id || !["low", "moderate", "high", "critical"].includes(v.severity))
    )
      return { status: "unavailable", reason: "unknown_advisory_format", fail: true };
  }
  if (execution.code === 1 && advisories.length === 0)
    return { status: "unavailable", reason: "failed_without_findings", fail: true };
  const allowed = new Set(exceptions.filter((e) => e.tool === tool).map((e) => e.id));
  const blocking = advisories.filter(
    (v) => !allowed.has(v.id) && (tool === "cargo" || ["high", "critical"].includes(v.severity)),
  );
  return {
    status: advisories.length ? "findings" : "clean",
    advisories,
    blocking,
    fail: blocking.length > 0,
  };
}
