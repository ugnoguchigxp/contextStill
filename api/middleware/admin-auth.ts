import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { groupedConfig } from "../../src/config.js";
import { projectIdentity } from "../../src/project-identity.js";

function readApiKeyFromAuthorizationHeader(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bearerMatch = trimmed.match(/^bearer\s+(.+)$/i);
  if (!bearerMatch) return null;
  const token = bearerMatch[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function hashApiKey(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isAuthorizedApiKey(configuredKey: string, providedKey: string): boolean {
  return timingSafeEqual(hashApiKey(configuredKey), hashApiKey(providedKey));
}

function isPublicHealthPath(path: string): boolean {
  return path === "/api/health" || path === "/api/health/" || path.startsWith("/api/health/");
}

export function adminApiKeyAuth(): MiddlewareHandler {
  return async (ctx, next) => {
    if (ctx.req.method === "OPTIONS" || isPublicHealthPath(ctx.req.path)) {
      return next();
    }

    const configuredKey = groupedConfig.admin.apiKey;
    if (!configuredKey) {
      return next();
    }

    const provided =
      ctx.req.header("x-admin-api-key") ??
      readApiKeyFromAuthorizationHeader(ctx.req.header("authorization") ?? undefined) ??
      "";

    if (!provided || !isAuthorizedApiKey(configuredKey, provided)) {
      ctx.header("WWW-Authenticate", `ApiKey realm="${projectIdentity.adminRealm}"`);
      return ctx.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
