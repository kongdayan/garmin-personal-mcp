// Scan tracked files, including staged additions, without printing matching secret values.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.length) throw new Error("No tracked files to scan. Stage the intended public files first.");
const blockedPaths = /(^|\/)(\.secrets|\.deploy|\.wrangler|node_modules|dist|coverage|test-results)(\/|$)|(^|\/)(\.dev\.vars|\.env)(\.(?!example$).*)?$|^(DEPLOYMENT\.md|deployment-check\.json|browser-check\.json|wrangler\.local\.jsonc|worker-configuration\.d\.ts)$|\.(log|pem|key)$/;
const patterns = [
  /GCDC_[A-Za-z0-9._-]{32,}/,
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:OWNER_LOGIN_KEY|MCP_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN)\s*=\s*["']?(?!replace-|synthetic-)[A-Za-z0-9_-]{32,}/,
];
const failures = [];
for (const file of files) {
  if (blockedPaths.test(file)) { failures.push(`${file}: private or generated file`); continue; }
  if (/\.(png|jpg|webp|ico)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  if (patterns.some(pattern => pattern.test(text))) failures.push(`${file}: possible credential`);
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Public-file check passed (${files.length} tracked files). This is a guardrail, not a security audit.`);
