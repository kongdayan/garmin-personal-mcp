import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";

const origin = "https://worker.example", resource = origin + "/mcp";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
afterEach(() => vi.restoreAllMocks());

async function send(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(origin + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) => send(path, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params),
});

async function register(redirectUri = redirect) {
  return send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    client_name: "Synthetic test <script>bad()</script>", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }) });
}

async function begin(clientId?: string) {
  const client = clientId ?? (await (await register()).json() as { client_id: string }).client_id;
  const verifier = "synthetic-pkce-verifier-0000000000000000000000000000";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const response = await send("/authorize?" + new URLSearchParams({ client_id: client, redirect_uri: redirect,
    response_type: "code", resource, scope: "garmin:read offline_access", state: "synthetic-state",
    code_challenge: challenge, code_challenge_method: "S256" }));
  const html = await response.text();
  expect(response.status, html).toBe(200);
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { client, verifier, handle, cookie, html };
}

async function approve(flow: Awaited<ReturnType<typeof begin>>, extra: Record<string, string> = {}) {
  return post("/authorize", { handle: flow.handle, decision: "approve", owner_key: env.OWNER_LOGIN_KEY, ...extra }, { Origin: origin, Cookie: flow.cookie });
}

describe("OAuth owner authorization", () => {
  it("invalidates both access and refresh when the owner increments AUTH_VERSION", async () => {
    const flow = await begin();
    const approved = await approve(flow);
    const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
    const response = await post("/oauth/token", { grant_type: "authorization_code", client_id: flow.client,
      code, code_verifier: flow.verifier, redirect_uri: redirect, resource });
    expect(response.status).toBe(200);
    const token = await response.json() as { access_token: string; refresh_token: string };
    const changed = { ...env, AUTH_VERSION: "2" };
    const denied = await send("/mcp", { headers: { Authorization: `Bearer ${token.access_token}` } }, changed);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    const refresh = await send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: flow.client, refresh_token: token.refresh_token, resource }) }, changed);
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("serves a script-free consent page with strict headers and escaped app names", async () => {
    const flow = await begin();
    expect(flow.html).toContain('href="/style.css"');
    expect(flow.html).toContain('type="password"');
    expect(flow.html).toContain('formnovalidate');
    expect(flow.html).toContain('历史记录');
    expect(flow.html).not.toContain('<script');
    expect(flow.html).not.toContain(env.OWNER_LOGIN_KEY);
    expect(flow.html).not.toContain(env.GARMIN_PERSONAL_API_KEY);
    const bad = await approve(flow, { owner_key: "wrong" });
    expect(bad.headers.get("Content-Security-Policy")).toContain("style-src 'self'");
    expect(bad.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
  });
  it("publishes discovery and challenges with the canonical resource and read scope", async () => {
    const unauthorized = await send("/mcp");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
    const metadata = await (await send("/.well-known/oauth-protected-resource/mcp")).json();
    expect(metadata).toMatchObject({ resource, authorization_servers: [origin], scopes_supported: ["garmin:read"] });
    const auth = await (await send("/.well-known/oauth-authorization-server")).json();
    expect(auth).toMatchObject({ issuer: origin, authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true, code_challenge_methods_supported: ["S256"] });
  });

  it("rejects arbitrary redirect registrations", async () => {
    expect((await register("https://attacker.example/callback")).status).toBe(400);
  });

  it("requires the owner key, bound browser cookie and same-origin form", async () => {
    const flow = await begin();
    expect(flow.html).not.toContain("<script>bad()");
    expect(flow.html).toContain("chatgpt.com");
    expect((await approve(flow, { owner_key: "wrong" })).status).toBe(401);
    expect((await post("/authorize", { handle: flow.handle, decision: "approve", owner_key: env.OWNER_LOGIN_KEY }, { Origin: origin })).status).toBe(400);
    expect((await post("/authorize", { handle: flow.handle, decision: "approve", owner_key: env.OWNER_LOGIN_KEY }, { Origin: "https://attacker.example", Cookie: flow.cookie })).status).toBe(403);
  });

  it("supports PKCE code exchange, MCP, refresh, replay rejection and revocation", async () => {
    const flow = await begin();
    const approved = await approve(flow);
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("Location")!);
    expect(location.origin).toBe("https://chatgpt.com");
    expect(location.searchParams.get("iss")).toBe(origin);
    expect(location.searchParams.get("state")).toBe("synthetic-state");
    const params = { grant_type: "authorization_code", client_id: flow.client, code: location.searchParams.get("code")!,
      code_verifier: flow.verifier, redirect_uri: redirect, resource };
    expect((await post("/oauth/token", { ...params, code_verifier: "wrong" })).status).toBe(400);
    expect((await post("/oauth/token", { ...params, resource: "https://attacker.example/mcp" })).status).toBe(400);
    const tokenResponse = await post("/oauth/token", params);
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string; refresh_token: string; resource: string };
    expect(token.resource).toBe(resource);
    expect(token.refresh_token).toBeTruthy();
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const listed = await send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(rpc) });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("garmin_daily");
    expect((await approve(flow)).status).toBe(400);
    const refreshed = await post("/oauth/token", { grant_type: "refresh_token", client_id: flow.client, refresh_token: token.refresh_token, resource });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { refresh_token: string; access_token: string };
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    const metadata = await (await send("/.well-known/oauth-authorization-server")).json() as { revocation_endpoint: string };
    const revoked = await post(new URL(metadata.revocation_endpoint).pathname, { client_id: flow.client, token: rotated.refresh_token, token_type_hint: "refresh_token" });
    expect(revoked.status).toBe(200);
    expect((await send("/mcp", { headers: { Authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401);
    expect((await post("/oauth/token", params)).status).toBe(400);
  });

  it("returns issuer and state when consent is denied", async () => {
    const flow = await begin();
    const response = await post("/authorize", { handle: flow.handle, decision: "deny" }, { Origin: origin, Cookie: flow.cookie });
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("iss")).toBe(origin);
  });

  it("accepts ChatGPT CIMD without dynamic registration", async () => {
    const client = "https://chatgpt.com/oauth/client.json";
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      expect(String(input)).toBe(client);
      return Response.json({ client_id: client, client_name: "ChatGPT", redirect_uris: [redirect],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], token_endpoint_auth_method: "private_key_jwt" });
    });
    const flow = await begin(client);
    expect(flow.html).toContain("ChatGPT");
    expect((await approve(flow)).status).toBe(302);
  });
});
