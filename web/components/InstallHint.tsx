"use client";

import { useEffect, useState } from "react";

const KEY = "setu-install-hint-dismissed";

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const webkit = /WebKit/.test(ua);
  const criOS = /CriOS/.test(ua);
  return iOS && webkit && !criOS;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || Boolean(nav.standalone);
}

export function InstallHint() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (isStandalone()) return;
    if (localStorage.getItem(KEY) === "1") return;
    if (isIosSafari()) {
      setText("Add Setu to your Home Screen: Share → Add to Home Screen");
      return;
    }
    // Chromium installability varies; soft hint only.
    setText("Install Setu from the browser menu for a full-screen voice app");
  }, []);

  if (!text) return null;

  return (
    <div className="fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex justify-center px-3">
      <div className="flex max-w-md items-start gap-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-sm">
        <p className="leading-snug">{text}</p>
        <button
          type="button"
          className="shrink-0 font-semibold text-slate-500"
          onClick={() => {
            localStorage.setItem(KEY, "1");
            setText(null);
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}
