// Import this into a Responses API request's tools array.
// OpenAI credentials and model selection belong to the calling application.
export function garminMcpTool({ url, token }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/mcp" || parsed.search || parsed.username || parsed.password) {
    throw new Error("Use the HTTPS Worker /mcp URL without credentials or query parameters.");
  }
  if (!token || token.length < 32) throw new Error("A separate MCP access token is required.");
  return {
    type: "mcp",
    server_label: "garmin_personal",
    server_description: "Read-only Garmin cloud history. Not live telemetry; freshness depends on watch sync.",
    server_url: parsed.href,
    authorization: token,
    require_approval: "always",
    allowed_tools: ["garmin_status", "garmin_daily", "garmin_sleep", "garmin_hrv", "garmin_activities", "garmin_activity", "garmin_series", "garmin_fitness_age"],
  };
}
