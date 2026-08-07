export type RealtimeSession = {
  protocol: "voice.v1";
  sessionId: string;
  token: string;
  expiresAt: string;
  transport: "livekit" | "mock";
  serverUrl: string | null;
  roomName: string | null;
  dataChannel: string;
  iceServers: Array<Record<string, unknown>>;
  capabilities: Array<"audio" | "data" | "barge_in">;
};

const API_URL = (process.env.SETU_API_URL || "http://localhost:8100").replace(/\/$/, "");

export async function createRealtimeSession(options: {
  userId: string;
  language: string;
  sessionId?: string | null;
}): Promise<RealtimeSession> {
  const response = await fetch(`${API_URL}/v1/realtime/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": options.userId },
    body: JSON.stringify({ language: options.language, sessionId: options.sessionId ?? undefined }),
  });
  if (!response.ok) throw new Error(`Realtime session failed (${response.status})`);
  return (await response.json()) as RealtimeSession;
}
