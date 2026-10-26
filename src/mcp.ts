import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GarminClient, GarminError, activity, dates, DAILY_FIELDS, hrv, numbers, object, sleep, type JsonObject } from "./garmin";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = new Date(value + "T00:00:00Z");
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}, "Use a real calendar date in YYYY-MM-DD format.");
const range = { startDate: date, endDate: date };

function assertRange(start: string, end: string) {
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days < 1 || days > 31) throw new GarminError("DATE_RANGE", "Choose an ordered date range of at most 31 days.");
}

function array(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new GarminError("GARMIN_FORMAT", "Garmin returned an unexpected list format.");
  return value;
}

export function createServer(env: Env) {
  const client = new GarminClient(env.GARMIN_PERSONAL_API_KEY, env.GARMIN_REGION);
  const server = new McpServer({ name: "garmin-personal", version: "1.0.0" }, {
    instructions: "Read-only Garmin cloud history, not live watch telemetry. Never describe retrievedAt as measurement time. Missing records are unknown, not zero. This server cannot sync/upload watch files. Dates are Garmin account-local calendar dates. Numeric sentinel values may indicate missing measurements. No medical diagnosis is supplied by these tools. Historical dates are supported; 31 days is a per-request range cap, NOT a rolling retention window. For longer sleep/HRV/activity ranges, split into non-overlapping inclusive windows of at most 31 days. Query daily summaries one date at a time. Follow nextOffset until null for every activity/series page; do not infer complete coverage from a single page or from empty results. Report requested versus retrieved dates, gaps and any unfinished pagination. Respect rate limits and retry later on 429; do not retry indefinitely. No bulk historical archive or automatic background sync is provided.",
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const _meta = { securitySchemes: [{ type: "oauth2", scopes: ["garmin:read"] }] };
  async function result(task: () => Promise<JsonObject>) {
    try {
      const data = await task();
      const envelope = { source: "garmin_personal_api", region: client.region, retrievedAt: new Date().toISOString(),
        isLiveTelemetry: false, ...data };
      return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], structuredContent: envelope };
    } catch (error) {
      const safe = error instanceof GarminError ? { code: error.code, message: error.message }
        : { code: "UPSTREAM_FAILURE", message: "The request could not be completed. No raw upstream details are exposed." };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
    }
  }

  server.registerTool("garmin_status", {
    description: "Report service mode and region without fetching health data. This is configuration status, not proof Garmin authentication is valid.",
    inputSchema: {}, annotations, _meta,
  }, () => result(async () => ({ mode: "read_only_cloud", authenticationVerified: false,
    healthDataStorage: "request_only", authorizationStorage: "cloudflare_kv",
    capabilities: ["daily", "sleep", "hrv", "activities", "activity", "series", "fitness_age"],
    limitation: "Freshness depends on the last upload from the watch, phone or WristBeam." })));

  server.registerTool("garmin_daily", {
    description: "Read one account-local day's steps, calories, heart rate, Body Battery, stress, respiration and SpO2 summaries. Daily aggregates are not current live readings; missing fields are omitted.",
    inputSchema: { date }, annotations, _meta,
  }, ({ date }) => result(async () => {
    const raw = await client.get(`/usersummary-service/usersummary/daily?calendarDate=${date}`);
    const src = object(raw);
    const metrics = numbers(src, DAILY_FIELDS);
    return { requestedDate: date, available: Object.keys(metrics).length > 0,
      ...dates(src, ["calendarDate", "lastSyncTimestampGMT"]), metrics,
      units: "Distances metres; energy kcal; heart rate bpm; respiration breaths/min; durations named Seconds/Duration in seconds, intensity minutes in minutes; SpO2 percent; Body Battery/stress 0–100." };
  }));

  server.registerTool("garmin_sleep", {
    description: "Read a historical inclusive range of up to 31 days of cloud sleep duration, stage durations and scores. Stage durations are not a stage timeline. No returned records means missing data, not no sleep.",
    inputSchema: range, annotations, _meta,
  }, ({ startDate, endDate }) => result(async () => {
    assertRange(startDate, endDate);
    const rows = array(await client.get(`/sleep-service/sleep/dailySleepSummariesByDate?startDate=${startDate}&endDate=${endDate}`)).map(sleep);
    return { startDate, endDate, available: rows.length > 0, records: rows, units: "Durations in seconds; sleep scores as supplied by Garmin." };
  }));

  server.registerTool("garmin_hrv", {
    description: "Read a historical inclusive range of up to 31 days of overnight HRV summaries, personal baseline and status. HRV is in milliseconds; omitted weekly averages are unknown. This is not a live RR stream.",
    inputSchema: range, annotations, _meta,
  }, ({ startDate, endDate }) => result(async () => {
    assertRange(startDate, endDate);
    const raw = await client.get(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
    const rows = raw === null ? [] : array(object(raw).hrvSummaries).map(hrv);
    return { startDate, endDate, available: rows.length > 0, records: rows, units: "HRV milliseconds." };
  }));

  server.registerTool("garmin_activities", {
    description: "Read a page within a historical inclusive range of at most 31 days of cloud workout summaries with activity IDs and numeric statistics. Names, descriptions, GPS and account/device identifiers are excluded. Empty pages do not prove complete historical coverage.",
    inputSchema: { ...range, offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(50).default(20) }, annotations, _meta,
  }, ({ startDate, endDate, offset, limit }) => result(async () => {
    assertRange(startDate, endDate);
    const rows = array(await client.get(`/activitylist-service/activities/search/activities?startDate=${startDate}&endDate=${endDate}&start=${offset}&limit=${limit}`)).map(activity);
    return { startDate, endDate, available: rows.length > 0, activities: rows, nextOffset: rows.length === limit ? offset + rows.length : null,
      units: "Distance metres; duration seconds; speed metres/second; heart rate bpm; power watts; energy kcal." };
  }));

  server.registerTool("garmin_activity", {
    description: "Read one workout's summary and numeric statistics by activityId from garmin_activities. No GPS, raw FIT or user notes. Does not claim to supply full charts, laps or time-in-zone.",
    inputSchema: { activityId: z.string().regex(/^\d{1,20}$/) }, annotations, _meta,
  }, ({ activityId }) => result(async () => {
    const raw = await client.get(`/activity-service/activity/${activityId}`);
    if (raw === null) return { available: false };
    const projected = activity(raw);
    return { available: projected.activityId !== undefined || Object.keys(object(projected.statistics)).length > 0,
      activity: projected, units: "Distance metres; duration seconds; speed metres/second; heart rate bpm; power watts; energy kcal." };
  }));

  server.registerTool("garmin_series", {
    description: "Read a paginated cloud day series for heart rate, Body Battery or SpO2 hourly averages. Returns native column descriptors; do not guess column meanings or interpret sentinel negatives as measurements. Not live telemetry.",
    inputSchema: { date, metric: z.enum(["heart_rate", "body_battery", "spo2"]), offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(240).default(120) }, annotations, _meta,
  }, ({ date, metric, offset, limit }) => result(async () => {
    const spec = {
      heart_rate: { path: `/wellness-service/wellness/dailyHeartRate?date=${date}`, rows: "heartRateValues", descriptors: "heartRateValueDescriptors" },
      body_battery: { path: `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`, rows: "bodyBatteryValuesArray", descriptors: "bodyBatteryValueDescriptorDTOList" },
      spo2: { path: `/wellness-service/wellness/daily/spo2acclimation/${date}`, rows: "spO2HourlyAverages", descriptors: "spO2HourlyAveragesDescriptorList" },
    }[metric];
    const raw = await client.get(spec.path);
    const src = object(Array.isArray(raw) ? raw.find(row => object(row).date === date) : raw);
    const rows = src[spec.rows] === undefined ? [] : array(src[spec.rows]);
    const selected = rows.slice(offset, offset + limit).map(row => Array.isArray(row)
      ? row.slice(0, 12).map(cell => typeof cell === "number" && Number.isFinite(cell) ? cell : null) : []);
    const descriptors = Array.isArray(src[spec.descriptors]) ? (src[spec.descriptors] as unknown[]).map(value => {
      const item = object(value), safe = numbers(item, ["index", "bodyBatteryValueDescriptorIndex", "spo2ValueDescriptorIndex", "spo2ValueDescIndex"]);
      for (const key of ["key", "bodyBatteryValueDescriptorKey", "spo2ValueDescriptorKey", "spo2ValueDescKey"]) {
        if (typeof item[key] === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(item[key])) safe[key] = item[key];
      }
      return safe;
    }) : [];
    return { date, metric, available: rows.length > 0, descriptors, points: selected, offset,
      totalPoints: rows.length, nextOffset: offset + selected.length < rows.length ? offset + selected.length : null,
      timestampUnit: "Unix milliseconds when specified by the descriptor; never a retrieval timestamp." };
  }));

  server.registerTool("garmin_fitness_age", {
    description: "Read Garmin fitness age as of the selected date. This is Garmin's estimate, not a medical age or diagnosis.",
    inputSchema: { date }, annotations, _meta,
  }, ({ date }) => result(async () => {
    const raw = object(await client.get(`/fitnessage-service/fitnessage/v2/${date}`));
    const metrics = numbers(raw, ["fitnessAge", "achievableFitnessAge", "previousFitnessAge"]);
    return { date, available: typeof metrics.fitnessAge === "number" && raw.invalidReason == null,
      ...dates(raw, ["lastUpdated"]), metrics };
  }));
  return server;
}
