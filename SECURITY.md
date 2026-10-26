# Security and privacy

## Supported deployment model

One owner, one Worker, one Garmin Personal API Key. Every authorized client reads that owner's data. This is **not** a shared, multi-user Garmin login service. Forking the source does not grant access to another deployment. Use your own Cloudflare account and OAuth KV namespace.

The Worker reads health data on demand and does not persist it. GitHub Actions receives deployment secrets; Cloudflare runs the code and holds the Garmin Key; the connected AI client receives requested health results. Those platforms' retention and access policies still apply. Activity identifiers and timestamps remain necessary for follow-up queries. GPS coordinates, raw FIT, user notes, profile and device identifiers are omitted by allowlist projection.

## Controls

- OAuth authorization code flow with S256 PKCE, canonical resource audience and exact ChatGPT callback validation. CIMD and DCR are supported by `@cloudflare/workers-oauth-provider`.
- A separate owner passphrase, constant-time digest comparison, browser-bound consent and same-origin form POST checks. Display names alone are not verified identities.
- One-hour access tokens, 30-day refresh-token lifetime, provider rotation/revocation and an owner-controlled authorization version.
- `AUTH_VERSION` invalidates previous authorizations at both MCP access and token exchange after the updated deployment propagates. Increment it; **never revert to an old value**. Keep it monotonic during code rollbacks.
- Static Bearer access is disabled by default. If enabled, its credential independently grants full read access, has no automatic expiry, and must be rotated separately. Changing the owner passphrase does not revoke already issued tokens; changing `AUTH_VERSION` does not revoke static Bearer access.
- Per-location Cloudflare rate limits: 20 requests/minute per IP and auth route; 60 authenticated MCP requests/minute for the deployment owner. These are best-effort abuse controls, not strict global quotas or billing caps. Shared egress IPs may hit the limit.
- No arbitrary Garmin URLs, automatic upstream redirects, or global token caches. 64 KiB incoming POST bound, 2 MB upstream JSON bound and a 24-second upstream deadline. Native OAuth library has additional validation.
- No third-party assets/scripts/analytics on the consent page. CSP, frame denial, no-store, noindex and referrer restrictions also apply to error responses.
- Health payloads and request headers/bodies are not logged by this application. Invocation logs and source-map uploads are disabled. Avoid raw `wrangler tail` output or adding debug log statements: tooling and hosting can expose query parameters, cookies or tokens.
- GitHub workflows use pinned Actions, read-only repository permissions, default-branch-only deployments, no `pull_request_target`, and no deployment secrets in PR checks or dependency installation. The secret file is mode 0600 and removed in normal/error completion and by a final workflow step. Runner termination can bypass cleanup; rely on ephemeral hosted runners, not shared persistent machines.

## Operating safely

Keep the Cloudflare API token restricted to the intended account and required permissions (Workers Scripts Edit, Workers KV Storage Edit, Account Settings Read). These permissions are account-scoped; a dedicated account reduces impact. Anyone who can merge executable code into your deployment branch can make that code read deployment secrets. Use protected branches and a protected `production` environment, and review upstream changes before syncing a fork. Dependency updates do not need automatic merge.

Never put real keys in issues, screenshots, URLs, workflow inputs or checked-in configuration. GitHub Secrets changes do not trigger a workflow: run **Check and deploy** manually after updating them. Changing only a Garmin Key on the same account can retain existing OAuth grants. Moving the deployment to a different Garmin account requires rotating the owner passphrase/static token and increasing `AUTH_VERSION` before reconnecting.

Cloudflare KV is eventually consistent; this library's KV-backed grants, code redemption and revocation should not be described as globally atomic. Disconnecting a client may only delete its local credentials if the client does not invoke the revocation endpoint. For an owner-wide cutoff, increase `AUTH_VERSION`, redeploy, and disable/rotate the static token. For immediate emergency containment, disable the Worker route while rotation propagates. This project has not had an independent security audit.

## Reporting a vulnerability

Use this repository's **Security → Report a vulnerability** private reporting form when available. Do not publish an exploit containing real health data, keys, OAuth codes, cookies or access tokens. If private reporting is unavailable, open an issue requesting a private reporting channel without vulnerability details or secrets.
