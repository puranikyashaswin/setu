"use client";

import { useEffect, useState } from "react";

export function PwaRegister() {
  const [updateReady, setUpdateReady] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
          setUpdateReady(true);
        }
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              setWaitingWorker(worker);
              setUpdateReady(true);
            }
          });
        });
      })
      .catch((error: unknown) => {
        console.warn("Setu service worker registration failed", error);
      });
  }, []);

  if (!updateReady) return null;

  return (
    <div className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <button
        type="button"
        className="rounded-full bg-[#172033] px-4 py-3 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(23,32,51,0.28)]"
        onClick={() => {
          waitingWorker?.postMessage({ type: "SKIP_WAITING" });
          window.location.reload();
        }}
      >
        Update Setu
      </button>
    </div>
  );
}
