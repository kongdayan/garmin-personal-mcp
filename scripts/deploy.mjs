import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configure, deploymentSecrets } from "./configure.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const secretFile = resolve(root, ".deploy/secrets.json");
try {
  // Validate everything before deploying or writing any secret.
  const secrets = deploymentSecrets(process.env);
  const config = await configure();
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const key of ["GARMIN_PERSONAL_API_KEY", "OWNER_LOGIN_KEY", "MCP_ACCESS_TOKEN"]) delete childEnv[key];
  const child = spawn(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "deploy",
    "--config", ".deploy/wrangler.json", "--secrets-file", secretFile], { cwd: root, env: childEnv, stdio: "inherit" });
  const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
  if (code !== 0) throw new Error("Wrangler deployment failed. Review the deployment status before retrying.");
  console.log(`Connection page: ${config.vars.PUBLIC_ORIGIN}/`);
  console.log(`MCP endpoint: ${config.vars.PUBLIC_ORIGIN}/mcp`);
} catch (error) {
  // Own validation messages never interpolate input values.
  console.error(error instanceof Error ? error.message : "Deployment failed.");
  process.exitCode = 1;
} finally {
  await rm(secretFile, { force: true });
}
