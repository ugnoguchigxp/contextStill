import { once } from "node:events";
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
test("provider registration, saved and draft tests, independent routing, scoped save and old URL redirects", async ({
  page,
}) => {
  let requests = 0;
  const probe = createServer((req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
  });
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address() as { port: number };
  try {
    await signIn(page, "/setting/llmprovider");
    await expect(page).toHaveURL(/\/setting\/connections$/);
    await page.getByRole("button", { name: "プロバイダーを追加" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("種類").selectOption("local-llm");
    await dialog.getByLabel("表示名").fill("E2E Worker");
    await dialog.getByLabel("Endpoint URL").fill(`http://127.0.0.1:${address.port}`);
    await dialog.getByLabel("モデル / Deployment名").fill("e2e-model");
    await dialog.getByRole("button", { name: "登録", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const worker = page
      .getByRole("row")
      .filter({ has: page.getByText("E2E Worker", { exact: true }) });
    await worker.getByRole("button", { name: "接続を確認" }).click();
    await expect(worker.getByText("接続確認済み", { exact: true })).toBeVisible();
    expect(requests).toBe(1);
    const before = await (await page.request.get("/api/settings")).json();
    const listing = await (await page.request.get("/api/settings/connections")).json();
    const connection = listing.connections.find((r: { name: string }) => r.name === "E2E Worker");
    await worker.getByRole("button", { name: "編集", exact: true }).click();
    await dialog.getByLabel("モデル / Deployment名").fill("draft-model");
    await dialog.getByRole("button", { name: "入力中の設定を確認" }).click();
    await expect(dialog.getByText("接続確認済み", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    expect(
      (await (await page.request.get("/api/settings/connections")).json()).connections.find(
        (r: { id: string }) => r.id === connection.id,
      ).model,
    ).toBe("e2e-model");
    await page.getByRole("link", { name: "詳細", exact: true }).click();
    await page.getByLabel("処理ロックの失効（秒）").fill("999");
    await page.getByRole("link", { name: "接続とモデル", exact: true }).click();
    await worker.getByRole("button", { name: "編集", exact: true }).click();
    await dialog.getByLabel("表示名").fill("E2E Worker Updated");
    await dialog.getByRole("button", { name: "変更を保存" }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("link", { name: "詳細", exact: true }).click();
    await expect(page.getByLabel("処理ロックの失効（秒）")).toHaveValue("999");
    await page.getByRole("button", { name: "詳細設定を保存", exact: true }).click();
    await expect(
      page.getByText("保存しました", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    const after = await (await page.request.get("/api/settings")).json();
    expect(after.settings.advanced.pipelineLockStaleSeconds).toBe(999);
    expect(
      after.settings.providers["local-llm"].models.find(
        (m: { id: string }) => m.id === connection.id,
      ).name,
    ).toBe("E2E Worker Updated");
    expect(after.settings.advanced.agentRuntime).toEqual(before.settings.advanced.agentRuntime);
    await page.getByRole("link", { name: "処理の割り当て", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Finding · Vibe Memory の接続" })
      .selectOption(connection.id);
    await page.getByRole("button", { name: "処理の割り当てを保存" }).click();
    await expect(
      page.getByText("保存しました", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    const routed = await (await page.request.get("/api/settings")).json();
    expect(routed.settings.taskRouting.findCandidate.vibe.provider).toBe("local-llm");
    expect(routed.settings.taskRouting.findCandidate.source).toEqual(
      before.settings.taskRouting.findCandidate.source,
    );
    expect(routed.settings.taskRouting.coverEvidence).toEqual(
      before.settings.taskRouting.coverEvidence,
    );
    await page.getByRole("link", { name: "並列処理と探索", exact: true }).click();
    await expect(page.getByText("32,768", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Poolを追加" }).click();
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "新しいPool", exact: true }) })
      .getByLabel("Pool名")
      .fill("E2E Pool");
    await page.getByRole("combobox", { name: "E2E Pool に接続を追加" }).selectOption(connection.id);
    await page.getByRole("button", { name: "Provider Poolを保存" }).click();
    await expect(
      page.getByText("保存しました", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await page.goto("/settings/embedding");
    await expect(page).toHaveURL(/\/setting\/retrieval#embedding$/);
    await expect(page.getByRole("heading", { name: "埋め込み", exact: true })).toBeVisible();
    await page.goto("/setting/connections");
    await page.screenshot({ path: ".tmp/settings-connections-e2e.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/setting/connections");
    await page.getByRole("button", { name: "プロバイダーを追加" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "プロバイダーを追加" })).toBeFocused();
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
});
