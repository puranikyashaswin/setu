const USER_KEY = "setu-user-id";
const EMAIL_KEY = "setu-user-email";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export function getStoredUserId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(USER_KEY);
}

export function getStoredEmail(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(EMAIL_KEY);
}

export function storeUser(userId: string, email?: string | null) {
  localStorage.setItem(USER_KEY, userId);
  if (email) localStorage.setItem(EMAIL_KEY, email);
}

export async function ensureGuestUser(): Promise<string> {
  const existing = getStoredUserId();
  const response = await fetch(`${API_URL}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: existing }),
  });
  if (!response.ok) {
    const fallback = existing ?? crypto.randomUUID();
    storeUser(fallback);
    return fallback;
  }
  const data = await response.json() as { user_id: string; email?: string | null };
  storeUser(data.user_id, data.email);
  return data.user_id;
}

export async function requestMagicLink(email: string): Promise<{ magic_link?: string | null; sent: boolean }> {
  const userId = getStoredUserId();
  const response = await fetch(`${API_URL}/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, user_id: userId }),
  });
  if (!response.ok) throw new Error("Could not send sign-in link");
  return response.json() as Promise<{ magic_link?: string | null; sent: boolean }>;
}

export async function verifyMagicLink(token: string): Promise<string> {
  const response = await fetch(`${API_URL}/auth/magic-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Sign-in link invalid or expired");
  const data = await response.json() as { user_id: string; email?: string | null };
  storeUser(data.user_id, data.email);
  return data.user_id;
}

export function authHeaders(): HeadersInit {
  const userId = getStoredUserId();
  return userId ? { "X-User-Id": userId } : {};
}
