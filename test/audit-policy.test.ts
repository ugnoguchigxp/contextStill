import { expect, test } from "vitest";
// @ts-expect-error Node script exercised directly as a policy contract.
import { classifyAudit } from "../scripts/testing/audit-policy.mjs";
test("audit distinguishes clean, major findings, unavailable and expired exceptions", () => {
  const clean = { code: 0, stdout: "{}" };
  expect(classifyAudit("bun", clean).status).toBe("clean");
  const found = {
    code: 1,
    stdout: JSON.stringify({ advisories: { one: { id: "GHSA-fixture", severity: "high" } } }),
  };
  expect(classifyAudit("bun", found).fail).toBe(true);
  expect(classifyAudit("bun", { ...clean, signal: "SIGKILL" }).status).toBe("unavailable");
  expect(classifyAudit("bun", { ...clean, stdout: "" }).fail).toBe(true);
  expect(classifyAudit("bun", { ...clean, code: 1 }).fail).toBe(true);
  const exception = {
    tool: "bun",
    id: "GHSA-fixture",
    reason: "synthetic test",
    owner: "test",
    expires: "2099-01-01",
  };
  expect(classifyAudit("bun", found, [exception]).fail).toBe(false);
  expect(classifyAudit("bun", found, [{ ...exception, expires: "2000-01-01" }]).fail).toBe(true);
  expect(
    classifyAudit("cargo", { code: 0, stdout: JSON.stringify({ vulnerabilities: { list: [] } }) })
      .fail,
  ).toBe(true);
});
