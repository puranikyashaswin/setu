import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-lg px-5 py-10 pt-[max(2rem,env(safe-area-inset-top))]">
      <Link href="/" className="text-sm font-medium text-slate-600">
        ← Setu
      </Link>
      <h1 className="font-display mt-4 text-4xl text-[#172033]">Terms</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        By using Setu you agree to use the service responsibly and understand its limits.
      </p>
      <section className="mt-8 space-y-4 text-sm leading-relaxed text-slate-700">
        <div>
          <h2 className="font-semibold text-slate-900">Not official advice</h2>
          <p className="mt-1">
            Setu helps you understand documents and answer questions aloud. It is not a government,
            bank, or legal authority. Always verify important actions with the issuer of a notice.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Document answers</h2>
          <p className="mt-1">
            When answering from a scanned document, Setu should stay grounded in the OCR text and say
            when something is not in the document.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Acceptable use</h2>
          <p className="mt-1">
            Do not abuse the API, attempt to access other users&apos; data, or upload unlawful content.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-slate-900">Availability</h2>
          <p className="mt-1">
            The service may be unavailable during maintenance, provider outages, or rate limits.
          </p>
        </div>
      </section>
      <p className="mt-10 text-xs text-slate-400">Last updated: 2026-08-02</p>
    </main>
  );
}
