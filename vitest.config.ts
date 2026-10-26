import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      MCP_ACCESS_TOKEN: "synthetic-test-token-0000000000000000",
      GARMIN_PERSONAL_API_KEY: "synthetic-garmin-key",
      OWNER_LOGIN_KEY: "synthetic-owner-login-key-0000000000000",
      PUBLIC_ORIGIN: "https://worker.example",
      ENABLE_STATIC_TOKEN: "true",
    } },
  })],
});
