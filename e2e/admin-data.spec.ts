import { test, expect } from "@playwright/test";

test("Admin can add and verify a new source", async ({ page }) => {
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: /add source/i }).click();
  await page.getByLabel("Source URI").fill("https://example.com/docs");
  await page.getByRole("button", { name: /save/i }).click();

  // 反映確認
  await expect(page.getByText("https://example.com/docs")).toBeVisible();
});
