// Exercise the generated production config with synthetic IDs, without uploading.
import { spawn } from "node:child_process";
import { configure } from "./configure.mjs";
await configure({ WORKER_NAME: "deployment-check", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  OAUTH_KV_ID: "b".repeat(32), PUBLIC_ORIGIN: "https://deployment-check.example.workers.dev" });
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run",
  "--config", ".deploy/wrangler.json", "--outdir", ".deploy/build"], { stdio: "inherit" });
child.once("exit", code => { process.exitCode = code ?? 1; });
child.once("error", () => { console.error("Deployment build failed to start"); process.exitCode = 1; });
