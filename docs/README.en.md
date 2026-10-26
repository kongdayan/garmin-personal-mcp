# Garmin Personal MCP

A self-hosted, read-only Garmin Personal API MCP server for ChatGPT and remote MCP clients, running on Cloudflare Workers. One deployment belongs to one owner. Deploy your own instance; no shared health-data service is provided.

## Deploy from your GitHub repository

1. Fork or use this repository as a template. Keep `main` as the default branch, or update the workflow branch conditions.
2. Obtain your own Garmin Personal API Key from [Garmin](https://developer.garmin.com/gc-developer-program/personal/personal-api/), subject to eligibility. China accounts use `cn`; worldwide accounts use `global`.
3. Set up a Cloudflare Workers subdomain and create a KV namespace for OAuth state. Keep this namespace across deployments.
4. Create an account-scoped Cloudflare API Token with Workers Scripts Edit, Workers KV Storage Edit and Account Settings Read. Do not use a Global API Key or a local Wrangler OAuth token.
5. Under **Settings → Secrets and variables → Actions**, add the following.

Secrets:

- `GARMIN_PERSONAL_API_KEY`: your Garmin Personal API Key.
- `OWNER_LOGIN_KEY`: an independent random 32–256 character base64url/hex passphrase, saved in your password manager.
- `CLOUDFLARE_API_TOKEN`: the restricted deployment token.
- Optional `MCP_ACCESS_TOKEN`: a separate random credential, only for opt-in static Bearer access.

Repository variables:

- `CLOUDFLARE_ACCOUNT_ID`, `OAUTH_KV_ID`: your account and KV namespace IDs.
- `WORKER_NAME`: e.g. `my-garmin-mcp`.
- `PUBLIC_ORIGIN`: e.g. `https://my-garmin-mcp.YOUR-SUBDOMAIN.workers.dev`, without `/mcp`.
- `DEPLOY_ENABLED=true`.
- Optional: `GARMIN_REGION=cn` (default) or `global`, `AUTH_VERSION=1`, `ENABLE_STATIC_TOKEN=false`.

6. Enable Actions and manually run **Check and deploy** on `main`. Subsequent main-branch pushes also deploy after checks. PR checks receive no deployment secrets. Protect your branch and `production` environment before allowing contributors to merge changes.
7. Visit your Worker homepage for the MCP URL and connection details. In ChatGPT, choose OAuth and CIMD/automatic registration, leaving Client ID/Secret blank. Enter **OWNER_LOGIN_KEY** on the consent page, never the Garmin Key.

**Updating a GitHub Secret does not trigger Actions.** After changing `GARMIN_PERSONAL_API_KEY`, manually run the workflow. The deployment uploads code and Worker Secrets together, using an ignored temporary file removed afterward.

## Data coverage

- Daily summaries and fitness age: one historical date per call.
- Sleep and HRV: an inclusive historical range of up to 31 days per call.
- Activities: up to 31 days per call, default 20 / maximum 50 records per page; follow `nextOffset`.
- Activity detail: one activity ID, projected summary fields only.
- Heart rate, Body Battery and hourly SpO2 series: one date, default 120 / maximum 240 points per page; follow `nextOffset`.
- Status: configuration only, not a Garmin credential check.

31 days is a request-span limit, **not** a rolling retention window. Split longer ranges into non-overlapping windows. The oldest accessible date depends on Garmin and has not been established for every account. Missing records are unknown, not zero. Today's data depends on the last cloud sync; this is not live watch telemetry. No GPS, FIT exports, complete laps, uploads or full-history archive is provided.

The MCP instructions tell AI clients to paginate, split ranges and report missing/unfinished coverage. A request for an entire year may still exceed a client's tool/context budget or upstream rate limits.

## Security and operations

Read [SECURITY.md](../SECURITY.md). OAuth uses PKCE, browser-bound consent, explicit scopes, exact ChatGPT callbacks and audience checks. Static tokens are off by default. Increment `AUTH_VERSION` and redeploy to invalidate older OAuth authorizations; never roll that number back. Rotate static credentials separately. Changing the owner passphrase alone does not revoke existing tokens.

The Worker does not persist health responses; GitHub stores deployment secrets, Cloudflare runs the Worker, and your AI client receives queried results. Platform retention policies still apply. This project is not independently audited. China-region data reads and a real ChatGPT connection have been observed; global-region live-account compatibility remains unverified.

Other clients with custom HTTP headers can opt into static Bearer access. OAuth callbacks for other clients are not currently supported. See [configuration example](../examples/workbuddy.remote-mcp.json); environment interpolation depends on the client.

## Development

Node.js 22+:

```sh
npm ci
npm run types
npm run check
npm test
npm run test:scripts
npm run check:public
npm run build
```

The checked-in Wrangler config is a development template. Use `npm run deploy` with the documented environment variables, not a direct production deployment of the placeholder config. `npm run verify:remote -- https://YOUR-WORKER...workers.dev` checks public discovery only, without health reads.

MIT licensed. Independent project; not affiliated with or endorsed by Garmin or OpenAI. The software license does not grant Garmin API access.
