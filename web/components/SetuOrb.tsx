"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { OrbState } from "@/lib/types";

export function SetuOrb({
  orbState,
  amplitude = 0.2,
  bass = 0,
  treble = 0,
  spectrum,
  autoStopProgress = 0,
  onClick,
}: {
  orbState: OrbState;
  amplitude?: number;
  bass?: number;
  treble?: number;
  spectrum: number[];
  autoStopProgress?: number;
  onClick: () => void;
}) {
  const energy = 1 + amplitude * 0.1;
  const targets = useRef(Array.from({ length: 8 }, () => 0));
  const smooth = useRef(Array.from({ length: 8 }, () => 0));
  const [blobPath, setBlobPath] = useState("");

  useEffect(() => {
    targets.current = spectrum.length === 8 ? spectrum : targets.current;
  }, [spectrum]);

  useEffect(() => {
    let frame = 0;
    const draw = (time: number) => {
      const center = 150;
      const base = orbState === "processing" ? 102 : 108;
      const audioStrength = orbState === "idle" ? 5 : orbState === "processing" ? 4 : 27;
      const points = Array.from({ length: 8 }, (_, index) => {
        smooth.current[index] += (targets.current[index] - smooth.current[index]) * 0.2;
        const drift = orbState === "idle" ? Math.sin(time / 1100 + index * 1.7) * 2.8 : 0;
        const radius = base + smooth.current[index] * audioStrength + drift;
        const angle = (Math.PI * 2 * index) / 8 + time / 10000;
        return { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius };
      });
      const midpoint = (a: (typeof points)[number], b: (typeof points)[number]) => ({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
      const start = midpoint(points[7], points[0]);
      const path =
        points.reduce((value, point, index) => {
          const next = midpoint(point, points[(index + 1) % points.length]);
          return `${value} Q ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
        }, `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`) + " Z";
      setBlobPath(path);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [orbState]);

  return (
    <button
      type="button"
      aria-label="Start or stop talking with Setu"
      onClick={onClick}
      className="relative grid aspect-square w-[min(60vw,45vh)] max-h-[45vh] max-w-[300px] place-items-center rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-[#4f46e5]/30"
    >
      <AnimatePresence>
        {orbState === "listening" && (
          <>
            <motion.span
              className="absolute inset-[-17%] rounded-full border border-[#4f46e5]/20"
              animate={{ scale: 1 + treble * 0.56, opacity: 0.16 + treble * 0.62 }}
              transition={{ type: "spring", stiffness: 520, damping: 18 }}
            />
            <motion.span
              className="absolute inset-[-9%] rounded-full border-2 border-[#ff6b00]/30"
              animate={{ scale: 1 + bass * 0.42, opacity: 0.24 + bass * 0.7 }}
              transition={{ type: "spring", stiffness: 600, damping: 16 }}
            />
            <motion.span
              className="absolute inset-[-3%] rounded-full border border-[#fff7ed]/90"
              animate={{ scale: 1 + amplitude * 0.2, opacity: 0.4 + amplitude * 0.55 }}
              transition={{ type: "spring", stiffness: 700, damping: 14 }}
            />
            {amplitude > 0.12 && (
              <motion.span
                key={`peak-${Math.round(amplitude * 20)}`}
                className="absolute inset-[-11%] rounded-full border border-[#ff6b00]/50"
                initial={{ scale: 0.92, opacity: 0.7 }}
                animate={{ scale: 1.48 + amplitude * 0.3, opacity: 0 }}
                transition={{ duration: 0.62, ease: "easeOut" }}
              />
            )}
            {autoStopProgress > 0 && (
              <motion.span
                className="absolute inset-[-13%] rounded-full border-2 border-[#ff6b00]"
                animate={{ opacity: autoStopProgress, scale: 1 + autoStopProgress * 0.25 }}
                transition={{ type: "tween", duration: 0.08 }}
              />
            )}
          </>
        )}
      </AnimatePresence>
      {orbState === "processing" && (
        <motion.span
          className="absolute inset-[-3px] rounded-full bg-[conic-gradient(from_0deg,#ff6b00,#f7c986,#4f46e5,#ff6b00)] p-[2px]"
          animate={{ rotate: 360 }}
          transition={{ duration: 1.15, repeat: Infinity, ease: "linear" }}
        >
          <span className="block h-full w-full rounded-full bg-[#fafafa]" />
        </motion.span>
      )}
      {orbState === "processing" &&
        [0, 1, 2].map((particle) => (
          <motion.span
            key={particle}
            className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-[#ff6b00]/70"
            animate={{
              x: [Math.cos(particle * 2.1) * 118, Math.cos(particle * 2.1 + Math.PI * 2) * 118],
              y: [Math.sin(particle * 2.1) * 118, Math.sin(particle * 2.1 + Math.PI * 2) * 118],
              opacity: [0.3, 0.9],
            }}
            transition={{
              type: "tween",
              duration: 3.2 + particle * 0.35,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
          />
        ))}
      <motion.svg
        viewBox="0 0 300 300"
        className="pointer-events-none absolute inset-0 h-full w-full"
        animate={{ rotate: orbState === "processing" ? 0 : 2 }}
        transition={{ type: "spring", stiffness: 40, damping: 14 }}
      >
        <defs>
          <radialGradient id="setu-blob" cx="34%" cy="26%">
            <stop offset="0" stopColor="#fff7ed" />
            <stop offset="0.28" stopColor="#ffc99a" />
            <stop offset="0.6" stopColor="#ff6b00" />
            <stop offset="1" stopColor="#5f58d5" />
          </radialGradient>
        </defs>
        <motion.path
          d={blobPath || "M150,150 Z"}
          fill="url(#setu-blob)"
          initial={false}
          animate={{
            opacity: orbState === "processing" ? 0.8 : 1,
            filter:
              orbState === "speaking"
                ? `drop-shadow(0 0 ${18 + amplitude * 34}px rgba(255,107,0,0.72))`
                : "drop-shadow(0 14px 28px rgba(79,70,229,0.34))",
          }}
          style={{ opacity: 1 }}
          transition={{ type: "tween", duration: 0.12 }}
        />
      </motion.svg>
      <motion.span
        className="h-full w-full"
        animate={{ y: orbState === "processing" ? -2 : 0, scale: orbState === "processing" ? 0.94 : 1 }}
        transition={{ type: "spring", stiffness: 180, damping: 18 }}
      >
        <motion.span
          className="relative block h-full w-full rounded-full bg-[radial-gradient(circle_at_32%_26%,#fff7ed_0%,#ffc99a_20%,#ff6b00_48%,#8b83e6_82%,#4f46e5_100%)] shadow-[0_28px_70px_-18px_rgba(79,70,229,0.46)]"
          animate={
            orbState === "idle"
              ? { scale: [1, 1.05] }
              : orbState === "listening"
                ? { scale: [1, energy], borderRadius: ["50%", "46% 54% 50% 50%"] }
                : orbState === "speaking"
                  ? {
                      scale: [1, 1.04 + amplitude * 0.12],
                      borderRadius: ["50%", "45% 55% 52% 48%"],
                      boxShadow: [
                        "0 28px 70px -18px rgba(79,70,229,0.46)",
                        `0 22px ${82 + amplitude * 28}px -10px rgba(255,107,0,${0.42 + amplitude * 0.44})`,
                      ],
                    }
                  : { scale: 1 }
          }
          transition={
            orbState === "processing"
              ? { type: "spring", stiffness: 180, damping: 18 }
              : {
                  type: "tween",
                  ease: "easeInOut",
                  repeat: Infinity,
                  repeatType: "reverse",
                  duration: orbState === "idle" ? 3 : 1.2,
                }
          }
        >
          <motion.span
            className="absolute inset-[13%] rounded-full bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.92),rgba(255,255,255,0.08)_43%,transparent_66%)]"
            animate={orbState === "processing" ? { rotate: 360 } : { opacity: [0.65, 1] }}
            transition={
              orbState === "processing"
                ? { type: "tween", duration: 2, repeat: Infinity, ease: "linear" }
                : { type: "tween", duration: 3, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" }
            }
          />
        </motion.span>
      </motion.span>
    </button>
  );
}
