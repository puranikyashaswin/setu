type SentryModule = {
  init: (options: {
    dsn: string;
    environment?: string;
    sendDefaultPii: boolean;
    beforeSend: (event: SentryEvent) => SentryEvent | null;
  }) => void;
};

type SentryEvent = {
  request?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
};

const SENSITIVE_KEYS = new Set([
  "audio",
  "audio_base64",
  "body",
  "document",
  "file",
  "message",
  "prompt",
  "query",
  "reply",
  "text",
  "transcript",
]);

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? "[Filtered]" : scrub(item),
      ]),
    );
  }
  return value;
}

function scrubEvent(event: SentryEvent): SentryEvent {
  return {
    ...event,
    request: scrub(event.request) as Record<string, unknown>,
    extra: scrub(event.extra) as Record<string, unknown>,
    contexts: scrub(event.contexts) as Record<string, unknown>,
  };
}

/** Load Sentry only when an explicitly public DSN is configured. */
export async function initSentry(): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn || typeof window === "undefined") return;

  try {
    // Optional dependency — avoid a hard package import so builds work without @sentry/nextjs.
    const load = new Function("m", "return import(m)") as (m: string) => Promise<SentryModule>;
    const Sentry = await load("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
    });
  } catch {
    // Sentry remains optional: telemetry must not block the app.
  }
}
