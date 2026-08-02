/** Map transport / provider failures to a visible user banner. */

export type ApiFailureKind = "network" | "rate_limit" | "credits" | "server" | "unknown";

export function classifyApiFailure(message: string, status?: number): ApiFailureKind {
  const m = (message || "").toLowerCase();
  if (status === 429 || /rate limit|too many requests|429/.test(m)) return "rate_limit";
  if (/credit|quota|insufficient|payment|billing/.test(m)) return "credits";
  if (status === 0 || /network|failed to fetch|offline|load failed/.test(m)) return "network";
  if (status != null && status >= 500) return "server";
  return "unknown";
}

export function bannerForApiFailure(kind: ApiFailureKind): string {
  switch (kind) {
    case "rate_limit":
      return "Setu is busy — wait a moment, then try again.";
    case "credits":
      return "Voice service credits ran out — check the API key plan.";
    case "network":
      return "No network — reconnect to keep talking with Setu.";
    case "server":
      return "Setu’s server had a problem — try again in a minute.";
    default:
      return "Something went wrong — tap to try again.";
  }
}
