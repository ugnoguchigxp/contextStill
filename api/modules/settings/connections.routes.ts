import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  connectionInputSchema,
  sectionPatchSchema,
} from "../../../src/modules/settings/connection-contracts.js";
import {
  SettingsConflict,
  connectionListing,
  deleteConnection,
  getSettingsOperation,
  patchSection,
  saveConnection,
} from "../../../src/modules/settings/provider-connections.service.js";
import {
  cancelProviderTest,
  getProviderTest,
  latestProviderTests,
  nativeSettingsRequest,
  providerRuntime,
  startProviderTest,
} from "../../../src/modules/settings/provider-tests.service.js";

const mutationSchema = z
  .object({ expectedRevision: z.number().int().min(0), operationId: z.string().uuid() })
  .strict();
const testSchema = z
  .object({
    operationId: z.string().uuid(),
    id: z.string().optional(),
    draft: connectionInputSchema.optional(),
  })
  .strict();
export const connectionsRouter = new Hono()
  .onError((error, c) => {
    if (error instanceof SettingsConflict || error.message === "settings_revision_conflict")
      return c.json(
        {
          error: {
            code: error.message,
            message: "設定が変更されました。再取得して変更箇所を確認してください。",
            details: error instanceof SettingsConflict ? error.details : undefined,
          },
        },
        409,
      );
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: "入力項目を確認してください。",
            issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
        400,
      );
    const safe =
      /^(connection_[a-z_]+|credential_[a-z_]+|primary_key_cannot_inherit|invalid_connection_field:[A-Za-z]+|invalid_setting_path|operation_id_conflict)$/.test(
        error.message,
      );
    return c.json(
      {
        error: {
          code: safe ? error.message : "settings_unavailable",
          message: safe
            ? error.message
            : "設定処理を完了できませんでした。保存状況を再取得してください。",
        },
      },
      safe ? 400 : 503,
    );
  })
  .get("/connections", async (c) =>
    c.json({ ...(await connectionListing()), tests: await latestProviderTests() }),
  )
  .post("/connections", zValidator("json", connectionInputSchema), async (c) =>
    c.json(await saveConnection(c.req.valid("json")), 201),
  )
  .patch("/connections/:id", zValidator("json", connectionInputSchema), async (c) =>
    c.json(await saveConnection(c.req.valid("json"), c.req.param("id"))),
  )
  .delete("/connections/:id", zValidator("json", mutationSchema), async (c) =>
    c.json(await deleteConnection(c.req.param("id"), c.req.valid("json"))),
  )
  .get("/connections/:id/runtime", async (c) => c.json(await providerRuntime(c.req.param("id"))))
  .post("/connection-tests", zValidator("json", testSchema), async (c) =>
    c.json(await startProviderTest(c.req.valid("json")), 202),
  )
  .get("/connection-tests/:id", async (c) => {
    const result = await getProviderTest(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "test_not_found" }, 404);
  })
  .delete("/connection-tests/:id", async (c) => {
    const result = await cancelProviderTest(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "test_not_found" }, 404);
  })
  .patch("/sections", zValidator("json", sectionPatchSchema), async (c) =>
    c.json(await patchSection(c.req.valid("json"))),
  )
  .get("/operations/:id", async (c) => {
    const result = await getSettingsOperation(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "operation_not_found" }, 404);
  })
  .get("/agent-policy", async (c) => {
    try {
      return c.json(await nativeSettingsRequest({ operation: "policy" }));
    } catch {
      return c.json({ error: "policy_unavailable" }, 503);
    }
  });
