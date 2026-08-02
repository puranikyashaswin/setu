import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-lg px-5 py-10 pt-[max(2rem,env(safe-area-inset-top))]">
      <Link href="/" className="text-sm font-medium text-slate-600">
        ← Setu
      </Link>
      <h1 className="font-display mt-4 text-4xl text-[#172033]">Privacy</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        Setu is a voice-first assistant. This page explains what we collect so you can use the product
        with clear expectations.
      </p>
      <section className="mt-8 space-y-4 text-sm leading-relaxed text-slate-700">
        <div>
          <h2 className="font-semibold text-slate-900">Microphone</h2>
          <p className="mt-1">
            Audio is captured to understand what you say (speech-to-text) and is sent to our API for
            processing. We do not sell your voice recordings.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Camera and documents</h2>
          <p className="mt-1">
            When you scan a paper, the image is sent for OCR so Setu can answer questions about that
            document. Document text is stored with your chat so you do not need to rescan.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Account</h2>
          <p className="mt-1">
            Guest mode works without email. If you sign in with a magic link, we store your email to
            sync chats across devices.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Retention</h2>
          <p className="mt-1">
            Chat history and document text stay until you delete the chat or request account deletion.
            Service logs may retain short technical timings for reliability.
          </p>
        </div>
      </section>
      <p className="mt-10 text-xs text-slate-400">Last updated: 2026-08-02</p>
    </main>
  );
}
