import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp";
import { readBounded } from "./garmin";
import { equalSecret, json } from "./security";
import { oauthFetch } from "./oauth";
import { homePage, stylesheet, connectionConfig } from "./pages";

async function mcpFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "json_required" }, 415);
  const limit = await env.DATA_LIMITER.limit({ key: `${env.PUBLIC_ORIGIN}:authenticated-owner` });
  if (!limit.success) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  return createMcpHandler(() => createServer(env))(request, env, ctx);
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return json({ error: "incorrect_host" }, 421);
    if (request.method === "GET") {
      if (url.pathname === "/healthz") return json({ service: "garmin-personal-mcp", version: "1.0.0", alive: true });
      if (url.pathname === "/") return new Response(homePage(env.PUBLIC_ORIGIN), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/style.css") return new Response(stylesheet, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (url.pathname === "/client-config.json") return json(connectionConfig(env.PUBLIC_ORIGIN));
    }
    if (url.pathname === "/mcp" && url.search) return json({ error: "query_parameters_not_supported" }, 400);
    const origin = request.headers.get("Origin");
    if (url.pathname === "/mcp" && origin && origin !== url.origin) return json({ error: "origin_not_allowed" }, 403);
    if (!env.GARMIN_PERSONAL_API_KEY
      || !env.OWNER_LOGIN_KEY || env.OWNER_LOGIN_KEY.length < 32
      || [env.GARMIN_PERSONAL_API_KEY, env.OWNER_LOGIN_KEY].some(s => s.startsWith("replace-"))
      || !/^[1-9]\d{0,8}$/.test(env.AUTH_VERSION)
      || !["true", "false"].includes(env.ENABLE_STATIC_TOKEN)
      || (env.ENABLE_STATIC_TOKEN === "true" && (!env.MCP_ACCESS_TOKEN || env.MCP_ACCESS_TOKEN.length < 32 || env.MCP_ACCESS_TOKEN.startsWith("replace-")))
      || !["cn", "global"].includes(env.GARMIN_REGION)) return json({ error: "service_not_configured" }, 503);
    if (["/authorize", "/oauth/register", "/oauth/token"].includes(url.pathname)) {
      const limit = await env.AUTH_LIMITER.limit({ key: `${env.PUBLIC_ORIGIN}:${url.pathname}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
      if (!limit.success) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    }
    if (request.method === "POST") {
      try { request = new Request(request, { body: await readBounded(request.body, 65_536) }); }
      catch { return json({ error: "request_too_large" }, 413); }
    }
    try {
      const header = request.headers.get("Authorization") ?? "";
      const isStatic = env.ENABLE_STATIC_TOKEN === "true" && url.pathname === "/mcp" && /^Bearer /i.test(header)
        && await equalSecret(header.slice(7), env.MCP_ACCESS_TOKEN ?? "");
      return isStatic ? await mcpFetch(request, env, ctx) : await oauthFetch(request, env, ctx, mcpFetch);
    } catch {
      return json({ error: "request_failed" }, 500);
    }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let response: Response;
    try { response = await handle(request, env, ctx); }
    catch { response = json({ error: "request_failed" }, 500); }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    // Preserve a same-origin Origin on the consent POST, suppress cross-origin referrers.
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'");
    if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, headers });
  }
} satisfies ExportedHandler<Env>;
