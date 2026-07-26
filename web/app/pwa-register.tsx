"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("Setu service worker registration failed", error);
    });
  }, []);

  return null;
}
