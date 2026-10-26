// Read-only post-deploy verification. No credentials or personal data required.
const base = new URL(process.env.PUBLIC_ORIGIN || process.argv[2] || "http://localhost:8787");
if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Use a bare origin.");
async function get(path) {
  return fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(20_000) });
}
const checks = [
  ["/", 200], ["/style.css", 200], ["/healthz", 200], ["/client-config.json", 200],
  ["/.well-known/oauth-authorization-server", 200], ["/.well-known/oauth-protected-resource/mcp", 200], ["/mcp", 401],
];
for (const [path, expected] of checks) {
  const response = await get(path);
  if (response.status !== expected) throw new Error(`Check ${path}: HTTP ${response.status}, expected ${expected}`);
  if (path === "/mcp" && !response.headers.get("www-authenticate")?.includes("resource_metadata")) throw new Error("OAuth challenge missing");
  if (path === "/client-config.json" && (await response.json()).url !== base.origin + "/mcp") throw new Error("Incorrect client URL");
  if (path === "/.well-known/oauth-authorization-server") {
    const meta = await response.json();
    if (meta.issuer !== base.origin || !meta.code_challenge_methods_supported.includes("S256")) throw new Error("Incorrect issuer or PKCE metadata");
  }
  console.log(`${path}: ${response.status} OK`);
}
console.log("Discovery verified. This does not test Garmin Key validity or a real client's OAuth flow.");
