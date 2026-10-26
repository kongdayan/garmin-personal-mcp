import { OAuthAuthorizationServer, OAuthResourceServer, AuthorizationError, CimdFetchError, insufficientScope, OAuthError,
  type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { equalSecret, json } from "./security";
import { consentPage, errorPage } from "./pages";

export const READ_SCOPE = "garmin:read";


function allowedRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.origin === "https://chatgpt.com" && !u.username && !u.password && !u.search && !u.hash
      && (u.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
  } catch { return false; }
}

async function authorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  if (request.method === "GET") {
    const clientId = new URL(request.url).searchParams.get("client_id") ?? "";
    if (clientId.includes(":") && !/^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(clientId)) {
      return json({ error: "unsupported_client" }, 400);
    }
    try {
      const parsed = await oauth.parseAuthRequest(request);
      if (!allowedRedirect(parsed.redirectUri) || !parsed.codeChallenge || parsed.codeChallengeMethod !== "S256"
        || parsed.scope.some(s => ![READ_SCOPE, "offline_access"].includes(s))) {
        return json({ error: "unsupported_authorization_request" }, 400);
      }
      parsed.scope = Array.from(new Set([READ_SCOPE, ...parsed.scope]));
      const details = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) return json({ error: "invalid_authorization_request" }, 400);
      throw error;
    }
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN) return json({ error: "origin_not_allowed" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return json({ error: "form_required" }, 415);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get("decision") !== "approve" || !await equalSecret(String(form.get("owner_key") ?? ""), env.OWNER_LOGIN_KEY)) {
      return new Response(errorPage("授权口令不正确。请检查个人授权口令后重试。"), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request,
      userId: "owner", metadata: {}, scope: approved.request.scope, props: { userId: "owner", authVersion: env.AUTH_VERSION },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return json({ error: "consent_expired_or_invalid" }, 400);
    throw error;
  }
}

export async function oauthFetch(request: Request, env: Env, ctx: ExecutionContext,
  mcpFetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>) {
  const issuer = env.PUBLIC_ORIGIN, resource = issuer + "/mcp";
  const server = new OAuthAuthorizationServer<Env>({
    issuer, resources: [resource], authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register", clientIdMetadataDocumentEnabled: true,
    scopesSupported: [READ_SCOPE, "offline_access"], accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
    clientRegistrationCallback: ({ clientMetadata }) => {
      if (!Array.isArray(clientMetadata.redirect_uris) || !clientMetadata.redirect_uris.length
        || !clientMetadata.redirect_uris.every(allowedRedirect)) return { description: "Only ChatGPT OAuth callbacks are allowed." };
    },
    tokenExchangeCallback: ({ props }) => {
      if ((props?.authVersion ?? "1") !== env.AUTH_VERSION) {
        throw new OAuthError("invalid_grant", { description: "The owner revoked this authorization. Connect again." });
      }
    },
    onError: () => { /* Never log authorization parameters or credentials. */ },
  });
  const path = new URL(request.url).pathname;
  if (path === "/authorize") return authorize(request, env, server.getOAuthApi(env));
  if (path === "/mcp" || path.startsWith("/.well-known/oauth-protected-resource")) {
    return new OAuthResourceServer<Env, { userId: string; authVersion?: string }>({
      resourceMetadata: { resource, authorization_servers: [issuer], resource_name: "Garmin Personal MCP" },
      requiredScopes: [READ_SCOPE],
      validateToken: e => (audience, token) => server.validateToken(audience, token, e),
      handler: { async fetch(req, e, context) {
        if ((context.props.authVersion ?? "1") !== e.AUTH_VERSION) {
          return json({ error: "invalid_token" }, 401, { "WWW-Authenticate": `Bearer resource_metadata="${e.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Authorization revoked. Connect again."` });
        }
        if (context.props.userId !== "owner") return json({ error: "forbidden" }, 403);
        if (!context.auth.scope.includes(READ_SCOPE)) return insufficientScope(context.auth, [READ_SCOPE]);
        return mcpFetch(req, e, context);
      } },
    }).fetch(request, env, ctx);
  }
  return server.fetch(request, env, ctx);
}
