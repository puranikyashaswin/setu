"use client";

import type { RefObject } from "react";
import { motion } from "framer-motion";

type CameraCopy = {
  hold: string;
};

type CameraOverlayProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  copy: CameraCopy;
  readiness: number;
  captureStreak: number;
  onClose: () => void;
  onCapture: () => void;
};

export function CameraOverlay({
  videoRef,
  canvasRef,
  copy,
  readiness,
  captureStreak,
  onClose,
  onCapture,
}: CameraOverlayProps) {
  return (
    <motion.section
      key="camera-overlay"
      className="absolute inset-0 z-20 bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      <canvas ref={canvasRef} className="hidden" />
      <div className="absolute inset-0 flex flex-col items-center justify-between bg-gradient-to-b from-black/45 via-transparent to-black/60 p-6 text-center text-white">
        <p className="mt-4 max-w-xs text-lg font-medium">{copy.hold}</p>
        <div
          className="grid h-16 w-16 place-items-center rounded-full border-2 border-white/80"
          style={{
            background: `conic-gradient(#ff6b00 ${(readiness / captureStreak) * 100}%, rgba(255,255,255,.22) 0)`,
          }}
        >
          <span className="grid h-12 w-12 place-items-center rounded-full bg-black/55 text-xs">
            {readiness}/{captureStreak}
          </span>
        </div>
        <div className="flex w-full justify-between">
          <button onClick={onClose} className="rounded-full bg-black/45 px-5 py-3 text-sm backdrop-blur">
            Cancel
          </button>
          <button onClick={onCapture} className="rounded-full bg-[#ff6b00] px-5 py-3 text-sm font-medium">
            Capture now
          </button>
        </div>
      </div>
    </motion.section>
  );
}
