import { handleAdmin } from "./admin";
import { authenticate, isAdmin } from "./codes";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { handleChat, handleSegment } from "./proxy";
import { assertDemoEnabled, assertRateLimit, assertUnderSpendCaps, demoEnabled } from "./quota";

// Called only by the Doppl desktop app's main process, never by a browser page: no CORS headers.
// Request and response bodies are never logged.

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "Use GET.");
    return json({ ok: true, demoEnabled: await demoEnabled(env) });
  }

  if (path.startsWith("/admin/")) {
    if (!(await isAdmin(request, env))) throw new ApiError("unauthorized", "Admin token missing or wrong.");
    return handleAdmin(request, env, path);
  }

  if (path === "/v1/session") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "Use POST.");
    const code = await authenticate(request, env);
    await assertRateLimit(env, code);
    return json({
      label: code.label,
      creations: { used: code.used_creations, max: code.max_creations },
      samImages: { used: code.used_sam_images, max: code.max_sam_images },
      expiresAt: code.expires_at,
      demoEnabled: await demoEnabled(env),
    });
  }

  if (path === "/v1/chat" || path === "/v1/segment") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "Use POST.");
    await assertDemoEnabled(env);
    const code = await authenticate(request, env);
    await assertRateLimit(env, code);
    await assertUnderSpendCaps(env);
    return path === "/v1/chat" ? handleChat(request, env, ctx, code) : handleSegment(request, env, ctx, code);
  }

  throw new ApiError("not_found", "Not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
      return errorResponse(new ApiError("internal_error", "Something went wrong in the demo service. Try again in a moment."));
    }
  },
} satisfies ExportedHandler<Env>;
