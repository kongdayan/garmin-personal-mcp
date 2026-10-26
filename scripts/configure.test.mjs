import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentConfig, deploymentSecrets } from "./configure.mjs";

const env = { WORKER_NAME: "my-garmin", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), OAUTH_KV_ID: "b".repeat(32),
  PUBLIC_ORIGIN: "https://my-garmin.example.workers.dev", GARMIN_PERSONAL_API_KEY: "GCDC_" + "x".repeat(64), OWNER_LOGIN_KEY: "o".repeat(48) };

test("deployment configuration never includes credentials and keeps stable resource identity", () => {
  const config = deploymentConfig({}, env);
  assert.equal(config.name, "my-garmin");
  assert.equal(config.kv_namespaces[0].id, env.OAUTH_KV_ID);
  assert.equal(config.vars.ENABLE_STATIC_TOKEN, "false");
  assert.equal(config.vars.AUTH_VERSION, "1");
  assert(!JSON.stringify(config).includes(env.GARMIN_PERSONAL_API_KEY));
  assert(!JSON.stringify(config).includes(env.OWNER_LOGIN_KEY));
});

test("rejects dangerous or inconsistent configuration before deployment", () => {
  for (const patch of [{ WORKER_NAME: "name;command" }, { PUBLIC_ORIGIN: "http://insecure.example" },
    { PUBLIC_ORIGIN: "https://user:password@example.com" }, { PUBLIC_ORIGIN: "https://example.com/mcp" },
    { PUBLIC_ORIGIN: "https://other.example.workers.dev" }, { PUBLIC_ORIGIN: "https://127.0.0.1" },
    { PUBLIC_ORIGIN: "https://example.com/?key=secret" }, { OAUTH_KV_ID: "0".repeat(32) },
    { GARMIN_REGION: "invalid" }, { AUTH_VERSION: "0" }, { ENABLE_STATIC_TOKEN: "yes" }]) {
    assert.throws(() => deploymentConfig({}, { ...env, ...patch }));
  }
});

test("requires separate secrets; static token is opt-in and validation never echoes values", () => {
  assert.deepEqual(Object.keys(deploymentSecrets(env)).sort(), ["GARMIN_PERSONAL_API_KEY", "OWNER_LOGIN_KEY"]);
  assert.throws(() => deploymentSecrets({ ...env, ENABLE_STATIC_TOKEN: "true" }));
  assert.throws(() => deploymentSecrets({ ...env, ENABLE_STATIC_TOKEN: "true", MCP_ACCESS_TOKEN: env.OWNER_LOGIN_KEY }));
  assert.throws(() => deploymentSecrets({ ...env, OWNER_LOGIN_KEY: "do-not-log-this" }), error => !error.message.includes("do-not-log-this"));
  assert.equal(deploymentSecrets({ ...env, ENABLE_STATIC_TOKEN: "true", MCP_ACCESS_TOKEN: "t".repeat(48) }).MCP_ACCESS_TOKEN.length, 48);
});
