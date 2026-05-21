import { test, expect } from "@playwright/test";

test("Knowledge and sources pages show core UI", async ({ page }) => {
  await page.goto("/sources");
  // より堅牢な待機処理とセレクタに変更
  const button = page.getByRole("button", { name: /show evidence/i });
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
  await expect(page.getByText("file://")).toBeVisible();
});
