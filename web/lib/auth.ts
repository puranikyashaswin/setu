const USER_KEY = "setu-user-id";
const EMAIL_KEY = "setu-user-email";
const SESSION_TOKEN_KEY = "setu-session-token";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export function getStoredUserId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(USER_KEY);
}

export function getStoredEmail(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(EMAIL_KEY);
}

export function getStoredSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_TOKEN_KEY);
}

export function storeUser(userId: string, email?: string | null, sessionToken?: string | null) {
  localStorage.setItem(USER_KEY, userId);
  if (email) localStorage.setItem(EMAIL_KEY, email);
  if (sessionToken) localStorage.setItem(SESSION_TOKEN_KEY, sessionToken);
}

type AuthUserResponse = {
  user_id: string;
  email?: string | null;
  session_token?: string | null;
};

export async function ensureGuestUser(): Promise<string> {
  const existing = getStoredUserId();
  const response = await fetch(`${API_URL}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ user_id: existing }),
  });
  if (!response.ok) {
    const fallback = existing ?? crypto.randomUUID();
    storeUser(fallback);
    return fallback;
  }
  const data = (await response.json()) as AuthUserResponse;
  storeUser(data.user_id, data.email, data.session_token);
  return data.user_id;
}

export async function requestMagicLink(email: string): Promise<{ magic_link?: string | null; sent: boolean }> {
  const userId = getStoredUserId();
  const response = await fetch(`${API_URL}/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, user_id: userId }),
  });
  if (!response.ok) throw new Error("Could not send sign-in link");
  return response.json() as Promise<{ magic_link?: string | null; sent: boolean }>;
}

export async function verifyMagicLink(token: string): Promise<string> {
  const response = await fetch(`${API_URL}/auth/magic-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Sign-in link invalid or expired");
  const data = (await response.json()) as AuthUserResponse;
  storeUser(data.user_id, data.email, data.session_token);
  return data.user_id;
}

export function authHeaders(): HeadersInit {
  const userId = getStoredUserId();
  return userId ? { "X-User-Id": userId } : {};
}
