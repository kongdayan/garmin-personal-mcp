import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function required(env, name, pattern) {
  const value = env[name];
  if (!value || !pattern.test(value)) throw new Error(`Missing or invalid ${name}. See docs/DEPLOY.md.`);
  return value;
}

export function deploymentConfig(base, env) {
  const name = required(env, "WORKER_NAME", /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
  const account = required(env, "CLOUDFLARE_ACCOUNT_ID", /^[a-f0-9]{32}$/);
  const kv = required(env, "OAUTH_KV_ID", /^(?!0{32}$)[a-f0-9]{32}$/);
  let origin;
  try { origin = new URL(env.PUBLIC_ORIGIN); } catch { throw new Error("PUBLIC_ORIGIN must be an HTTPS origin."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/" || origin.port || origin.hostname === "localhost" || !origin.hostname.includes(".")
    || /^[\d.]+$/.test(origin.hostname) || origin.hostname.includes(":")) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without credentials, port, path, query or fragment.");
  if (origin.hostname.endsWith(".workers.dev") && origin.hostname.split(".")[0] !== name) {
    throw new Error("WORKER_NAME must match PUBLIC_ORIGIN's workers.dev hostname.");
  }
  const region = env.GARMIN_REGION || "cn";
  const authVersion = env.AUTH_VERSION || "1";
  const staticToken = env.ENABLE_STATIC_TOKEN || "false";
  if (!["cn", "global"].includes(region)) throw new Error("GARMIN_REGION must be cn or global.");
  if (!/^[1-9]\d{0,8}$/.test(authVersion)) throw new Error("AUTH_VERSION must be a positive integer, up to 9 digits.");
  if (!["true", "false"].includes(staticToken)) throw new Error("ENABLE_STATIC_TOKEN must be true or false.");
  return { ...base, name, account_id: account, main: "../src/index.ts", tsconfig: "../tsconfig.json",
    kv_namespaces: [{ binding: "OAUTH_KV", id: kv }],
    vars: { GARMIN_REGION: region, PUBLIC_ORIGIN: origin.origin, AUTH_VERSION: authVersion, ENABLE_STATIC_TOKEN: staticToken },
  };
}

export function deploymentSecrets(env) {
  const key = required(env, "GARMIN_PERSONAL_API_KEY", /^GCDC_[A-Za-z0-9._-]{32,}$/);
  const owner = required(env, "OWNER_LOGIN_KEY", /^[A-Za-z0-9_-]{32,256}$/);
  if (key === owner) throw new Error("Garmin Key and owner passphrase must be independent.");
  const secrets = { GARMIN_PERSONAL_API_KEY: key, OWNER_LOGIN_KEY: owner };
  if (env.ENABLE_STATIC_TOKEN === "true") {
    const token = required(env, "MCP_ACCESS_TOKEN", /^[A-Za-z0-9_-]{32,256}$/);
    if (token === owner || token === key) throw new Error("Static token must be independent from other credentials.");
    secrets.MCP_ACCESS_TOKEN = token;
  }
  return secrets;
}

export async function configure(env = process.env) {
  const base = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  const config = deploymentConfig(base, env);
  await mkdir(resolve(root, ".deploy"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, ".deploy/wrangler.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await configure(); console.log("Deployment config generated. No credentials written to configuration."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
