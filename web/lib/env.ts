/**
 * Build/runtime checks for public env. Fail the production build if the API URL
 * would break iPhone Safari (http on an https page → mixed-content WS block).
 */

export function isHttpsApiUrl(apiUrl: string): boolean {
  return /^https:\/\//i.test(apiUrl.trim());
}

export function isLocalApiUrl(apiUrl: string): boolean {
  return /localhost|127\.0\.0\.1/i.test(apiUrl);
}

/** Throws when production build has a non-https API URL (except localhost). */
export function assertProductionApiUrl(apiUrl: string, nodeEnv: string = process.env.NODE_ENV ?? ""): void {
  if (nodeEnv !== "production") return;
  const url = (apiUrl || "").trim();
  if (!url) {
    throw new Error("NEXT_PUBLIC_API_URL is required for production builds");
  }
  if (!isHttpsApiUrl(url) && !isLocalApiUrl(url)) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must be https:// in production (got ${url}). iPhone Safari blocks mixed-content WebSockets.`,
    );
  }
}
