import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

afterEach(() => vi.restoreAllMocks());

async function request(body: unknown, options: { token?: string; origin?: string; bindings?: Env; raw?: string } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://worker.example/mcp", {
    method: "POST", headers: {
      Authorization: `Bearer ${options.token ?? env.MCP_ACCESS_TOKEN}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(options.origin ? { Origin: options.origin } : {}),
    }, body: options.raw ?? JSON.stringify(body),
  }), options.bindings ?? env, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6))
    : text ? JSON.parse(text) : null;
  return { status: response.status, payload, text, headers: response.headers };
}

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const call = (name: string, args: unknown = {}) => request(rpc("tools/call", { name, arguments: args }));

function upstream(value: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/personal\.connectapi\.garmin\.cn\//);
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Accept")).toBe("*/*");
    if (String(input).endsWith("/personal-api-key/token")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("ApiKey synthetic-garmin-key");
      return new Response("synthetic.token.signature", { headers: { "Content-Type": "text/plain" } });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic.token.signature");
    return status === 204 ? new Response(null, { status }) : Response.json(value, { status });
  });
}

describe("authenticated stateless MCP in Workers runtime", () => {
  it("exposes only public connection configuration and guards static-token opt-in", async () => {
    const ctx = createExecutionContext();
    const config = await worker.fetch(new Request("https://worker.example/client-config.json"), env, ctx);
    const text = await config.text();
    expect(JSON.parse(text)).toMatchObject({ url: "https://worker.example/mcp", authentication: "oauth", client_id: null, client_secret: null });
    expect(text).not.toContain(env.OWNER_LOGIN_KEY);
    expect(text).not.toContain(env.GARMIN_PERSONAL_API_KEY);
    expect(text).not.toContain(env.MCP_ACCESS_TOKEN!);
    expect((await request(rpc("tools/list"), { bindings: { ...env, ENABLE_STATIC_TOKEN: "false" } })).status).toBe(401);
    const home = await worker.fetch(new Request("https://worker.example/"), env, ctx);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("31 天是单次跨度");
    expect(home.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    await waitOnExecutionContext(ctx);
  });

  it("limits authenticated traffic before Garmin requests and bounds auth endpoints", async () => {
    const fetch = upstream({});
    vi.spyOn(env.DATA_LIMITER, "limit").mockResolvedValue({ success: false });
    const limited = await call("garmin_daily", { date: "2026-10-25" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(env.AUTH_LIMITER, "limit").mockResolvedValue({ success: false });
    const ctx = createExecutionContext();
    const token = await worker.fetch(new Request("https://worker.example/oauth/token", { method: "POST" }), env, ctx);
    expect(token.status).toBe(429);
    await waitOnExecutionContext(ctx);
  });
  it("fails closed before reaching Garmin", async () => {
    const fetch = upstream({});
    expect((await request(rpc("tools/list"), { token: "wrong" })).status).toBe(401);
    expect((await request(rpc("tools/list"), { bindings: { ...env, MCP_ACCESS_TOKEN: "" } })).status).toBe(503);
    expect((await request(rpc("tools/list"), { origin: "https://untrusted.example" })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds incoming messages", async () => {
    expect((await request({}, { raw: "x".repeat(65_537) })).status).toBe(413);
  });

  it("negotiates MCP and exposes eight read-only tools without Garmin requests", async () => {
    const fetch = upstream({});
    const init = await request(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(init.status).toBe(200);
    expect(init.payload.result.serverInfo.name).toBe("garmin-personal");
    const listed = await request(rpc("tools/list"));
    expect(listed.payload.result.tools).toHaveLength(8);
    expect(listed.payload.result.tools.every((tool: any) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
    const status = await call("garmin_status");
    expect(status.payload.result.structuredContent.authenticationVerified).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exchanges a plain-text token and projects only daily measurements", async () => {
    const fetch = upstream({ calendarDate: "2026-10-22", totalSteps: 123, restingHeartRate: null, userProfileId: "PRIVATE", notes: "PRIVATE", latitude: 123 });
    const response = await call("garmin_daily", { date: "2026-10-22" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.payload.result.structuredContent.metrics).toEqual({ totalSteps: 123, restingHeartRate: null });
    expect(response.payload.result.structuredContent.isLiveTelemetry).toBe(false);
    expect(response.text).not.toContain("PRIVATE");
    expect(response.text).not.toContain("synthetic");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not turn missing HRV into zero", async () => {
    upstream(null, 204);
    const response = await call("garmin_hrv", { startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(response.payload.result.structuredContent).toMatchObject({ available: false, records: [] });
  });

  it("rejects impossible dates and excessive ranges before fetching", async () => {
    const fetch = upstream({});
    expect((await call("garmin_daily", { date: "2026-02-30" })).payload.result.isError).toBe(true);
    expect((await call("garmin_sleep", { startDate: "2026-01-01", endDate: "2026-02-28" })).payload.result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500, 526, 302])("returns safe errors for Garmin HTTP %s", async status => {
    upstream({ secret: "PRIVATE_UPSTREAM_BODY" }, status);
    const response = await call("garmin_daily", { date: "2026-10-22" });
    expect(response.payload.result.isError).toBe(true);
    expect(response.text).not.toContain("PRIVATE_UPSTREAM_BODY");
    expect(response.text).not.toContain("synthetic");
  });

  it("paginates series preserving nulls and native descriptors", async () => {
    upstream({ heartRateValues: [[1, 60], [2, null], [3, -1]], heartRateValueDescriptors: [{ index: 0, key: "timestamp" }, { index: 1, key: "heartrate", notes: "PRIVATE" }] });
    const response = await call("garmin_series", { date: "2026-10-22", metric: "heart_rate", offset: 1, limit: 1 });
    expect(response.payload.result.structuredContent).toMatchObject({ points: [[2, null]], totalPoints: 3, nextOffset: 2 });
    expect(response.text).not.toContain("PRIVATE");
  });

  it("removes workout names, coordinates and account identifiers", async () => {
    upstream([{ activityId: 123, activityName: "PRIVATE_HOME", ownerId: "PRIVATE_OWNER", activityType: { typeKey: "running" }, distance: 1000, startLatitude: 25 }]);
    const response = await call("garmin_activities", { startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(response.payload.result.structuredContent.activities).toEqual([{ activityId: "123", sport: "running", statistics: { distance: 1000 } }]);
    expect(response.text).not.toContain("PRIVATE");
  });

  it("projects flat sleep records and excludes personal notes", async () => {
    upstream([{ calendarDate: "2026-10-22", sleepTimeSeconds: 25000, userNote: "PRIVATE", sleepScores: { overall: { value: 80, feedback: "PRIVATE" } } }]);
    const response = await call("garmin_sleep", { startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(response.payload.result.structuredContent.records).toEqual([{ calendarDate: "2026-10-22", sleepTimeSeconds: 25000, scores: { overall: { value: 80 } } }]);
    expect(response.text).not.toContain("PRIVATE");
  });

  it("projects HRV personal baselines without inventing missing averages", async () => {
    upstream({ hrvSummaries: [{ calendarDate: "2026-10-22", lastNightAvg: 45, baseline: { balancedLow: 40, balancedUpper: 60 }, status: "BALANCED" }] });
    const response = await call("garmin_hrv", { startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(response.payload.result.structuredContent.records[0]).toEqual({ calendarDate: "2026-10-22", lastNightAvg: 45, baseline: { balancedLow: 40, balancedUpper: 60 }, status: "BALANCED" });
  });

  it("handles nested activity details and an empty summary", async () => {
    const fetch = upstream({ activityId: 42, activityTypeDTO: { typeKey: "cycling" }, summaryDTO: { distance: 1000, startLatitude: 25 }, metadataDTO: { ownerId: "PRIVATE" } });
    const response = await call("garmin_activity", { activityId: "42" });
    expect(response.payload.result.structuredContent.activity).toEqual({ activityId: "42", sport: "cycling", statistics: { distance: 1000 } });
    expect(response.text).not.toContain("PRIVATE");
    fetch.mockRestore();
    upstream({});
    expect((await call("garmin_activity", { activityId: "42" })).payload.result.structuredContent.available).toBe(false);
  });

  it("handles the observed object form of fitness age", async () => {
    upstream({ fitnessAge: 30, achievableFitnessAge: 28, userProfileId: "PRIVATE" });
    const response = await call("garmin_fitness_age", { date: "2026-10-22" });
    expect(response.payload.result.structuredContent).toMatchObject({ available: true, metrics: { fitnessAge: 30, achievableFitnessAge: 28 } });
    expect(response.text).not.toContain("PRIVATE");
  });

  it("isolates token state between separate MCP calls", async () => {
    const fetch = upstream({ totalSteps: 100 });
    await call("garmin_daily", { date: "2026-10-21" });
    await call("garmin_daily", { date: "2026-10-22" });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/personal-api-key/token"))).toHaveLength(2);
  });
});
