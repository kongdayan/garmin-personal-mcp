export type JsonObject = Record<string, unknown>;

export class GarminError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}

// Bound even chunked responses; never place Garmin errors, tokens or raw bodies in logs.
export async function readBounded(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new GarminError("RESPONSE_TOO_LARGE", "Response exceeds the configured size limit.");
      }
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

export class GarminClient {
  private token?: string;
  readonly region: "cn" | "global";
  private readonly base: string;
  private readonly deadline = AbortSignal.timeout(24_000);

  constructor(private readonly key: string, region: string) {
    if (region !== "cn" && region !== "global") throw new GarminError("CONFIGURATION", "Invalid Garmin region.");
    this.region = region;
    this.base = region === "cn" ? "https://personal.connectapi.garmin.cn" : "https://personal.connectapi.garmin.com";
  }

  private async request(path: string, method: "GET" | "POST", authorization: string): Promise<Response> {
    try {
      return await fetch(this.base + path, {
        method,
        headers: { Authorization: authorization, Accept: "*/*" },
        redirect: "manual",
        signal: this.deadline,
      });
    } catch { throw new GarminError("NETWORK", "Garmin could not be reached within the request deadline."); }
  }

  private async reject(response: Response): Promise<never> {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      this.token = undefined;
      throw new GarminError("GARMIN_AUTH", "Garmin rejected authentication. Check the server-side key, expiry and selected region.");
    }
    if (response.status === 429) throw new GarminError("GARMIN_RATE_LIMIT", "Garmin rate limit reached. Retry later.");
    if (response.status === 526) throw new GarminError("GARMIN_TLS", "The Cloudflare-to-Garmin request returned HTTP 526 (upstream certificate validation failure). Health data is unavailable; this is not an empty record or an invalid user credential.");
    throw new GarminError("GARMIN_HTTP", `Garmin returned HTTP ${response.status}. This is not evidence that no health records exist.`);
  }

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const response = await this.request("/personalapitoken-service/personal-api/personal-api-key/token", "POST", `ApiKey ${this.key}`);
    if (response.status !== 200) return this.reject(response);
    // This endpoint returns a text/plain JWT, not a JSON token envelope.
    const token = (await readBounded(response.body, 16_384)).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new GarminError("GARMIN_FORMAT", "Garmin returned an unexpected token format.");
    }
    this.token = token;
    return token;
  }

  async get(path: string): Promise<unknown> {
    // Paths are constructed exclusively by the fixed tool handlers.
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/.test(path)) {
      throw new GarminError("INVALID_PATH", "Unsupported request path.");
    }
    const response = await this.request(path, "GET", `Bearer ${await this.accessToken()}`);
    if (response.status === 204) { await response.body?.cancel(); return null; }
    if (response.status !== 200) return this.reject(response);
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel();
      throw new GarminError("GARMIN_FORMAT", "Garmin returned a non-JSON data response.");
    }
    const text = await readBounded(response.body, 2_000_000);
    try { return JSON.parse(text); }
    catch { throw new GarminError("GARMIN_FORMAT", "Garmin returned invalid JSON."); }
  }
}

// Projection is an allowlist: arbitrary profile fields, notes, coordinates and device IDs never pass through.
export function numbers(value: unknown, keys: readonly string[]): JsonObject {
  const src = object(value), out: JsonObject = {};
  for (const key of keys) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (v === null) out[key] = null;
  }
  return out;
}

export function dates(value: unknown, keys: readonly string[]): JsonObject {
  const src = object(value), out: JsonObject = {};
  for (const key of keys) {
    const v = src[key];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T][\d:.+Z-]+)?$/.test(v)) out[key] = v;
  }
  return out;
}

export const DAILY_FIELDS = [
  "totalSteps", "dailyStepGoal", "totalDistanceMeters", "totalKilocalories", "activeKilocalories", "bmrKilocalories",
  "floorsAscended", "floorsDescended", "moderateIntensityMinutes", "vigorousIntensityMinutes", "intensityMinutesGoal",
  "activeSeconds", "highlyActiveSeconds", "sedentarySeconds", "sleepingSeconds", "restingHeartRate", "minHeartRate", "maxHeartRate",
  "lastSevenDaysAvgRestingHeartRate", "averageStressLevel", "maxStressLevel", "restStressDuration", "lowStressDuration",
  "mediumStressDuration", "highStressDuration", "bodyBatteryHighestValue", "bodyBatteryLowestValue", "bodyBatteryMostRecentValue",
  "bodyBatteryChargedValue", "bodyBatteryDrainedValue", "averageSpo2", "lowestSpo2", "latestSpo2", "avgWakingRespirationValue",
  "highestRespirationValue", "lowestRespirationValue", "latestRespirationValue", "hydrationValueInML", "hydrationGoalInML",
] as const;

export const ACTIVITY_FIELDS = [
  "distance", "duration", "movingDuration", "elapsedDuration", "elevationGain", "elevationLoss", "averageSpeed", "maxSpeed",
  "calories", "averageHR", "maxHR", "minHR", "averagePower", "maxPower", "normalizedPower", "averageRunningCadenceInStepsPerMinute",
  "averageRunCadence", "maxRunCadence", "averageBikeCadence", "trainingEffect", "aerobicTrainingEffect", "anaerobicTrainingEffect",
  "activityTrainingLoad", "trainingStressScore", "steps", "totalSets", "totalReps", "moderateIntensityMinutes", "vigorousIntensityMinutes",
] as const;

export function activity(value: unknown): JsonObject {
  const src = object(value), detail = object(src.summaryDTO);
  const stats = Object.keys(detail).length ? detail : src;
  const id = src.activityId;
  const sport = object(src.activityType ?? src.activityTypeDTO).typeKey;
  return {
    ...(typeof id === "number" && Number.isSafeInteger(id) ? { activityId: String(id) }
      : typeof id === "string" && /^\d{1,20}$/.test(id) ? { activityId: id } : {}),
    ...(typeof sport === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(sport) ? { sport } : {}),
    ...dates(stats, ["startTimeGMT", "startTimeLocal"]),
    statistics: numbers(stats, ACTIVITY_FIELDS),
  };
}

export function sleep(value: unknown): JsonObject {
  const src = object(value), scores = object(src.sleepScores), safeScores: JsonObject = {};
  for (const key of ["overall", "duration", "quality", "deep", "rem", "light", "awakenings", "restlessness", "stress", "totalDuration"]) {
    if (Object.hasOwn(scores, key)) safeScores[key] = numbers(scores[key], ["value", "optimalStart", "optimalEnd"]);
  }
  return {
    ...dates(src, ["calendarDate"]),
    ...numbers(src, ["sleepTimeSeconds", "napTimeSeconds", "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds", "awakeSleepSeconds",
      "awakeCount", "averageSpO2Value", "lowestSpO2Value", "averageRespirationValue", "avgSleepStress", "avgHeartRate"]),
    scores: safeScores,
  };
}

export function hrv(value: unknown): JsonObject {
  const src = object(value), state = src.status;
  return {
    ...dates(src, ["calendarDate"]),
    ...numbers(src, ["lastNightAvg", "lastNight5MinHigh", "weeklyAvg"]),
    baseline: numbers(src.baseline, ["lowUpper", "balancedLow", "balancedUpper", "markerValue"]),
    ...(typeof state === "string" && /^[A-Z_]{1,40}$/.test(state) ? { status: state } : {}),
  };
}
