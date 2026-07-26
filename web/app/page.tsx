"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Menu, MessageSquarePlus, Mic, Plus, Settings2, Square, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

type Language = "te" | "hi" | "en" | "mr" | "ta" | "kn" | "bn" | "gu" | "ml" | "pa" | "or";
type OrbState = "idle" | "listening" | "processing" | "speaking";
type StackService = "VISION" | "105B" | "BULBUL" | "SAARAS";
type ChatRole = "user" | "setu";
type Turn = {
  id: string;
  role: ChatRole;
  text: string;
  language: Language;
  evidence?: { page: number; quote: string }[];
  timestamp: number;
};
type Session = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  language: Language;
  docId: string | null;
  turns: Turn[];
};
type AnswerSheet = { answer: string; evidence: { page: number; quote: string }[]; verified: boolean };
type ApiHistoryMessage = { role: string; content: string; language?: Language };

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const LANGUAGE_LABELS: Record<Language, string> = { te: "Telugu", hi: "Hindi", en: "English", mr: "Marathi", ta: "Tamil", kn: "Kannada", bn: "Bengali", gu: "Gujarati", ml: "Malayalam", pa: "Punjabi", or: "Odia" };
/** Match language names in English, native script, and common transliteration — anywhere in the transcript. */
const EXPLICIT_LANGUAGE: [RegExp, Language][] = [
  [/\b(telugu|telugulo)\b|తెలుగు/i, "te"],
  [/\bhindi\b|हिंदी|हिन्दी/i, "hi"],
  [/\bmarathi\b|मराठी/i, "mr"],
  [/\btamil\b|தமிழ்/i, "ta"],
  [/\bkannada\b|ಕನ್ನಡ/i, "kn"],
  [/\b(bengali|bangla)\b|বাংলা/i, "bn"],
  [/\bgujarati\b|ગુજરાતી/i, "gu"],
  [/\bmalayalam\b|മലയാളം/i, "ml"],
  [/\bpunjabi\b|ਪੰਜਾਬੀ/i, "pa"],
  [/\b(odia|oriya|odisha)\b|ଓଡ଼ିଆ/i, "or"],
  [/\b(english|angrezi)\b/i, "en"],
];
const LANGUAGE_NAME_TOKEN = "telugu|telugulo|hindi|marathi|tamil|kannada|bengali|bangla|gujarati|malayalam|punjabi|odia|oriya|odisha|english|angrezi|తెలుగు|हिंदी|हिन्दी|मराठी|தமிழ்|ಕನ್ನಡ|বাংলা|ગુજરાતી|മലയാളം|ਪੰਜਾਬੀ|ଓଡ଼ିଆ";
// Short language-switch only — bare name or "speak/switch to X".
const LANGUAGE_CHANGE = new RegExp(
  `^(please\\s+)?((speak|talk|switch|change|use)(\\s+to)?\\s+(in\\s+)?)?(${LANGUAGE_NAME_TOKEN})(\\s+please)?[.!?]*$`,
  "i",
);
const SILENCE_MS = 1600;
const MIN_RECORDING_MS = 1200;
const NO_SPEECH_MS = 6000;
const SPEECH_LEVEL = 0.008;
const AMBIENT_MS = 300;
const CAPTURE_STREAK = 3;
const CAPTURE_CELL_EDGE = 0.10; // local text density inside a grid cell
const CAPTURE_PEAK_EDGE = 0.12; // strongest cell must look like text/print
const CAPTURE_GLOBAL_EDGE = 0.045; // whole frame can be mostly person + room
const DOCUMENT_MENTION = /(document|notice|paper|form|scan|read this|दस्तावेज|काग[ज़ज]|नोटिस|పత్రం|నోటీసు|ದಾಖಲೆ|ஆவணம்|নথি|દસ્તાવેજ|രേഖ|ਦਸਤਾਵੇਜ਼|ଦଲିଲ)/i;
/** User wants to present/scan a document — open camera, do not call /ask. */
const WANTS_TO_SHOW_DOCUMENT = /(i have (a |the )?document|show (you )?(my |the )?document|scan (this |my |the )?(document|paper|notice)|document ఉంది|నా దగ్గర|చూపించ|दस्तावेज (दिखा|है)|कागद दाखव)/i;
const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|thankyou|bye|goodbye|good morning|good evening|నమస్కారం|ధన్యవాదాలు|नमस्ते|धन्यवाद|வணக்கம்|ನಮಸ್ಕಾರ|नमस्कार|নমস্কার)\b/i;

function explicitLanguage(transcript: string) {
  return EXPLICIT_LANGUAGE.find(([pattern]) => pattern.test(transcript))?.[1];
}

function resolveLanguage(transcript: string, apiLanguage?: string): Language {
  const explicit = explicitLanguage(transcript);
  if (explicit) return explicit;
  const code = apiLanguage?.toLowerCase().split("-", 1)[0] as Language | undefined;
  return code && code in LANGUAGE_LABELS ? code : "en";
}

/** Greetings / thanks / language switch — everything else with a loaded doc goes to /ask. */
function isClearSmallTalk(transcript: string) {
  const text = transcript.trim();
  return SMALL_TALK.test(text) || LANGUAGE_CHANGE.test(text);
}

type TimingStage = "scan" | "listen" | "converse" | "ask" | "speak";
type TurnTiming = { listen: number; converse: number; ask: number; speak: number };

function emptyTurnTiming(): TurnTiming {
  return { listen: 0, converse: 0, ask: 0, speak: 0 };
}

function logStageTiming(stage: TimingStage, ms: number) {
  console.log(`[timing] ${stage} ${ms}ms`);
}

function logTurnTiming(timing: TurnTiming) {
  const total = timing.listen + timing.converse + timing.ask + timing.speak;
  console.log(
    `[turn] listen=${timing.listen}ms converse=${timing.converse}ms ask=${timing.ask}ms speak=${timing.speak}ms total=${total}ms`,
  );
}

function SetuOrb({ orbState, amplitude = 0.2, bass = 0, treble = 0, spectrum, autoStopProgress = 0, onClick }: { orbState: OrbState; amplitude?: number; bass?: number; treble?: number; spectrum: number[]; autoStopProgress?: number; onClick: () => void }) {
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
      const midpoint = (a: typeof points[number], b: typeof points[number]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const start = midpoint(points[7], points[0]);
      const path = points.reduce((value, point, index) => {
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
    <button onClick={onClick} aria-label="Start or stop voice recording" className="relative grid w-[min(60vw,45vh)] max-h-[45vh] max-w-[300px] aspect-square place-items-center rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-[#4f46e5]/30">
      <AnimatePresence>
        {orbState === "listening" && <>
          <motion.span className="absolute inset-[-17%] rounded-full border border-[#4f46e5]/20" animate={{ scale: 1 + treble * 0.56, opacity: 0.16 + treble * 0.62 }} transition={{ type: "spring", stiffness: 520, damping: 18 }} />
          <motion.span className="absolute inset-[-9%] rounded-full border-2 border-[#ff6b00]/30" animate={{ scale: 1 + bass * 0.42, opacity: 0.24 + bass * 0.7 }} transition={{ type: "spring", stiffness: 600, damping: 16 }} />
          <motion.span className="absolute inset-[-3%] rounded-full border border-[#fff7ed]/90" animate={{ scale: 1 + amplitude * 0.2, opacity: 0.4 + amplitude * 0.55 }} transition={{ type: "spring", stiffness: 700, damping: 14 }} />
          {amplitude > 0.12 && <motion.span key={`peak-${Math.round(amplitude * 20)}`} className="absolute inset-[-11%] rounded-full border border-[#ff6b00]/50" initial={{ scale: 0.92, opacity: 0.7 }} animate={{ scale: 1.48 + amplitude * 0.3, opacity: 0 }} transition={{ duration: 0.62, ease: "easeOut" }} />}
          {autoStopProgress > 0 && <motion.span className="absolute inset-[-13%] rounded-full border-2 border-[#ff6b00]" animate={{ opacity: autoStopProgress, scale: 1 + autoStopProgress * 0.25 }} transition={{ type: "tween", duration: 0.08 }} />}
        </>}
      </AnimatePresence>
      {orbState === "processing" && <motion.span className="absolute inset-[-3px] rounded-full bg-[conic-gradient(from_0deg,#ff6b00,#f7c986,#4f46e5,#ff6b00)] p-[2px]" animate={{ rotate: 360 }} transition={{ duration: 1.15, repeat: Infinity, ease: "linear" }}><span className="block h-full w-full rounded-full bg-[#fafafa]" /></motion.span>}
      {orbState === "processing" && [0, 1, 2].map((particle) => <motion.span key={particle} className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-[#ff6b00]/70" animate={{ x: [Math.cos(particle * 2.1) * 118, Math.cos(particle * 2.1 + Math.PI * 2) * 118], y: [Math.sin(particle * 2.1) * 118, Math.sin(particle * 2.1 + Math.PI * 2) * 118], opacity: [0.3, 0.9] }} transition={{ type: "tween", duration: 3.2 + particle * 0.35, repeat: Infinity, repeatType: "reverse", ease: "linear" }} />)}
      <motion.svg viewBox="0 0 300 300" className="pointer-events-none absolute inset-0 h-full w-full" animate={{ rotate: orbState === "processing" ? 0 : 2 }} transition={{ type: "spring", stiffness: 40, damping: 14 }}>
        <defs><radialGradient id="setu-blob" cx="34%" cy="26%"><stop offset="0" stopColor="#fff7ed" /><stop offset="0.28" stopColor="#ffc99a" /><stop offset="0.6" stopColor="#ff6b00" /><stop offset="1" stopColor="#5f58d5" /></radialGradient></defs>
        <motion.path d={blobPath} fill="url(#setu-blob)" animate={{ opacity: orbState === "processing" ? 0.8 : 1, filter: orbState === "speaking" ? `drop-shadow(0 0 ${18 + amplitude * 34}px rgba(255,107,0,0.72))` : "drop-shadow(0 14px 28px rgba(79,70,229,0.34))" }} transition={{ type: "tween", duration: 0.12 }} />
      </motion.svg>
      <motion.span className="h-full w-full" animate={{ y: orbState === "processing" ? -2 : 0, scale: orbState === "processing" ? 0.94 : 1 }} transition={{ type: "spring", stiffness: 180, damping: 18 }}>
        <motion.span
          className="relative block h-full w-full rounded-full bg-[radial-gradient(circle_at_32%_26%,#fff7ed_0%,#ffc99a_20%,#ff6b00_48%,#8b83e6_82%,#4f46e5_100%)] shadow-[0_28px_70px_-18px_rgba(79,70,229,0.46)]"
          animate={orbState === "idle" ? { scale: [1, 1.05] } : orbState === "listening" ? { scale: [1, energy], borderRadius: ["50%", "46% 54% 50% 50%"] } : orbState === "speaking" ? { scale: [1, 1.04 + amplitude * 0.12], borderRadius: ["50%", "45% 55% 52% 48%"], boxShadow: ["0 28px 70px -18px rgba(79,70,229,0.46)", `0 22px ${82 + amplitude * 28}px -10px rgba(255,107,0,${0.42 + amplitude * 0.44})`] } : { scale: 1 }}
          transition={orbState === "processing" ? { type: "spring", stiffness: 180, damping: 18 } : { type: "tween", ease: "easeInOut", repeat: Infinity, repeatType: "reverse", duration: orbState === "idle" ? 3 : 1.2 }}
        >
          <motion.span className="absolute inset-[13%] rounded-full bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.92),rgba(255,255,255,0.08)_43%,transparent_66%)]" animate={orbState === "processing" ? { rotate: 360 } : { opacity: [0.65, 1] }} transition={orbState === "processing" ? { type: "tween", duration: 2, repeat: Infinity, ease: "linear" } : { type: "tween", duration: 3, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" }} />
        </motion.span>
      </motion.span>
    </button>
  );
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, length * 2, true);
  let offset = 44;
  chunks.forEach((chunk) => chunk.forEach((sample) => { view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true); offset += 2; }));
  return new Blob([buffer], { type: "audio/wav" });
}

function makeSession(language: Language): Session {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: "New chat", createdAt: now, updatedAt: now, language, docId: null, turns: [] };
}

function titleFromTurns(turns: Turn[]) {
  const firstUser = turns.find((turn) => turn.role === "user");
  if (!firstUser) return "New chat";
  const words = firstUser.text.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.join(" ") || "New chat";
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayLabel(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function groupSessionsByDay(sessions: Session[]): [string, Session[]][] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, Session[]>();
  for (const session of sorted) {
    const day = dayLabel(session.updatedAt);
    const list = groups.get(day) ?? [];
    list.push(session);
    groups.set(day, list);
  }
  return [...groups.entries()];
}

function historyForApi(turns: Turn[], maxTurns = 6): ApiHistoryMessage[] {
  return turns.slice(-maxTurns).map((turn) => ({
    role: turn.role === "setu" ? "assistant" : "user",
    content: turn.text,
    language: turn.language,
  }));
}

function loadSessionsFromStorage(fallbackLanguage: Language): { sessions: Session[]; activeId: string } {
  try {
    const raw = localStorage.getItem("setu-sessions");
    if (raw) {
      const parsed = JSON.parse(raw) as Session[];
      if (Array.isArray(parsed) && parsed.length) {
        let activeId = localStorage.getItem("setu-active-session") ?? parsed[0].id;
        if (!parsed.some((session) => session.id === activeId)) activeId = parsed[0].id;
        return { sessions: parsed, activeId };
      }
    }
    const legacy = JSON.parse(localStorage.getItem("setu-history") ?? "[]") as Array<{
      id?: string;
      userText?: string;
      setuText?: string;
      role?: ChatRole;
      text?: string;
      language?: Language;
      evidence?: { page: number; quote: string }[];
      timestamp?: number;
    }>;
    if (Array.isArray(legacy) && legacy.length) {
      const turns: Turn[] = [];
      for (const item of legacy) {
        const language = item.language && item.language in LANGUAGE_LABELS ? item.language : "en";
        const timestamp = item.timestamp ?? Date.now();
        if (item.userText !== undefined && item.setuText !== undefined) {
          turns.push({ id: crypto.randomUUID(), role: "user", text: item.userText, language, timestamp });
          turns.push({ id: crypto.randomUUID(), role: "setu", text: item.setuText, language, evidence: item.evidence, timestamp });
        } else if (item.role && item.text) {
          turns.push({ id: item.id ?? crypto.randomUUID(), role: item.role, text: item.text, language, evidence: item.evidence, timestamp });
        }
      }
      turns.sort((a, b) => a.timestamp - b.timestamp);
      if (turns.length) {
        const session: Session = {
          id: crypto.randomUUID(),
          title: titleFromTurns(turns),
          createdAt: turns[0].timestamp,
          updatedAt: turns[turns.length - 1].timestamp,
          language: turns[turns.length - 1].language,
          docId: null,
          turns,
        };
        return { sessions: [session], activeId: session.id };
      }
    }
  } catch { /* start fresh */ }
  const session = makeSession(fallbackLanguage);
  return { sessions: [session], activeId: session.id };
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const startX = useRef(0);
  const dragging = useRef(false);
  const longPressTimer = useRef<number | null>(null);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={onDelete}
        className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-red-500 text-white"
        aria-label={`Delete ${session.title}`}
      >
        <Trash2 size={18} />
      </button>
      <button
        type="button"
        onClick={() => {
          if (offset < -40) {
            setOffset(-80);
            return;
          }
          onSelect();
        }}
        onTouchStart={(event) => {
          startX.current = event.touches[0]?.clientX ?? 0;
          dragging.current = true;
          clearLongPress();
          longPressTimer.current = window.setTimeout(() => {
            dragging.current = false;
            onDelete();
          }, 550);
        }}
        onTouchMove={(event) => {
          if (!dragging.current) return;
          const x = event.touches[0]?.clientX ?? startX.current;
          const delta = x - startX.current;
          if (Math.abs(delta) > 8) clearLongPress();
          setOffset(Math.max(-80, Math.min(0, delta)));
        }}
        onTouchEnd={() => {
          clearLongPress();
          dragging.current = false;
          setOffset((value) => (value < -40 ? -80 : 0));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onDelete();
        }}
        className={`relative z-[1] min-h-11 w-full border p-3 text-left transition ${active ? "border-[#ff6b00]/40 bg-[#fff7ed]" : "border-slate-200/70 bg-white/80 hover:border-[#ff6b00]/30"}`}
        style={{ transform: `translateX(${offset}px)` }}
      >
        <p className="truncate text-sm font-medium text-slate-800">{session.title}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          {relativeTime(session.updatedAt)}
          {session.docId ? " · document" : ""}
        </p>
      </button>
    </div>
  );
}

/**
 * Find a document-like blob anywhere in the frame (phone screen / paper can be
 * off-center). A face alone rarely forms a dense multi-cell text cluster.
 */
function analyzeDocumentFrame(data: Uint8ClampedArray, width: number, height: number) {
  const luminance = (index: number) => data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  const GRID = 6;
  const densities: number[][] = Array.from({ length: GRID }, () => Array(GRID).fill(0));
  let globalEdges = 0;
  let globalTotal = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const x0 = Math.floor((col * width) / GRID);
      const y0 = Math.floor((row * height) / GRID);
      const x1 = Math.floor(((col + 1) * width) / GRID);
      const y1 = Math.floor(((row + 1) * height) / GRID);
      let edges = 0;
      let total = 0;
      for (let y = y0; y < Math.min(y1, height - 1); y += 1) {
        for (let x = x0; x < Math.min(x1, width - 1); x += 1) {
          total += 1;
          globalTotal += 1;
          const index = (y * width + x) * 4;
          const value = luminance(index);
          sum += value;
          sumSquares += value * value;
          const grad = Math.abs(value - luminance(index + 4)) + Math.abs(value - luminance(((y + 1) * width + x) * 4));
          if (grad > 52) {
            edges += 1;
            globalEdges += 1;
          }
        }
      }
      densities[row][col] = edges / Math.max(1, total);
    }
  }

  let hotCells = 0;
  let peak = 0;
  const hot: boolean[][] = densities.map((row) =>
    row.map((density) => {
      peak = Math.max(peak, density);
      const isHot = density >= CAPTURE_CELL_EDGE;
      if (isHot) hotCells += 1;
      return isHot;
    }),
  );

  // Largest 4-connected blob of hot cells (document/phone cluster).
  const seen = Array.from({ length: GRID }, () => Array(GRID).fill(false));
  let largestBlob = 0;
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      if (!hot[row][col] || seen[row][col]) continue;
      let size = 0;
      const stack = [[row, col]];
      seen[row][col] = true;
      while (stack.length) {
        const [r, c] = stack.pop()!;
        size += 1;
        for (const [dr, dc] of neighbors) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= GRID || nc >= GRID || seen[nr][nc] || !hot[nr][nc]) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
      largestBlob = Math.max(largestBlob, size);
    }
  }

  let bestBlock = 0;
  for (let row = 0; row < GRID - 1; row += 1) {
    for (let col = 0; col < GRID - 1; col += 1) {
      const block =
        (densities[row][col] + densities[row][col + 1] + densities[row + 1][col] + densities[row + 1][col + 1]) / 4;
      bestBlock = Math.max(bestBlock, block);
    }
  }

  const edgeDensity = globalEdges / Math.max(1, globalTotal);
  const brightnessVariance = sumSquares / Math.max(1, globalTotal) - (sum / Math.max(1, globalTotal)) ** 2;
  const passed =
    peak >= CAPTURE_PEAK_EDGE &&
    bestBlock >= CAPTURE_CELL_EDGE &&
    largestBlob >= 3 &&
    hotCells >= 4 &&
    edgeDensity >= CAPTURE_GLOBAL_EDGE &&
    brightnessVariance > 180;

  return { edgeDensity, brightnessVariance, peak, bestBlock, hotCells, largestBlob, passed };
}

export default function Home() {
  const [language, setLanguage] = useState<Language>("en");
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [amplitude, setAmplitude] = useState(0.2);
  const [bands, setBands] = useState({ bass: 0, treble: 0 });
  const [spectrum, setSpectrum] = useState(Array.from({ length: 8 }, () => 0));
  const [autoStopProgress, setAutoStopProgress] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micThreshold, setMicThreshold] = useState(SPEECH_LEVEL);
  const [statusText, setStatusText] = useState("Tap to begin");
  const [thinkingStage, setThinkingStage] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [answerSheet, setAnswerSheet] = useState<AnswerSheet | null>(null);
  const [showProof, setShowProof] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [activeService, setActiveService] = useState<StackService | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [speaker, setSpeaker] = useState("shubh");
  const [pace, setPace] = useState(1);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReadiness, setCameraReadiness] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<{
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    processor: ScriptProcessorNode;
    silenceGain: GainNode;
    chunks: Float32Array[];
    sampleRate: number;
    startedAt: number;
    heardSpeech: boolean;
    silentSince: number | null;
    raf: number;
    speechThreshold: number;
    ambientSum: number;
    ambientCount: number;
    thresholdLocked: boolean;
    lastLogAt: number;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const startRecordingRef = useRef<(() => void) | null>(null);
  const previewCacheRef = useRef(new Map<string, string>());
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const languageRef = useRef<Language>("en");
  const languageLockedRef = useRef(false);
  const docIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraCapturedRef = useRef(false);
  const cameraGoodChecksRef = useRef(0);
  const turnTimingRef = useRef<TurnTiming>(emptyTurnTiming());

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const cameraText = useState<Record<Language, { hold: string; show: string; reading: string; ready: string; unclear: string }>>({
    en: { hold: "Hold the document steady — fill more of the frame if you can", show: "Show me the document", reading: "Reading your document", ready: "What would you like to know?", unclear: "I could not read that clearly, hold it flat in good light" },
    te: { hold: "పత్రాన్ని కెమెరా ముందు ఉంచండి", show: "పత్రాన్ని చూపించండి", reading: "మీ పత్రాన్ని చదువుతున్నాను", ready: "మీకు ఏమి తెలుసుకోవాలి?", unclear: "ఇది స్పష్టంగా చదవలేకపోయాను, మంచి వెలుతురులో నిటారుగా పట్టుకోండి" },
    hi: { hold: "दस्तावेज़ को कैमरे के सामने रखें", show: "मुझे दस्तावेज़ दिखाइए", reading: "मैं आपका दस्तावेज़ पढ़ रहा हूँ", ready: "आप क्या जानना चाहते हैं?", unclear: "मैं इसे साफ़ नहीं पढ़ सका, अच्छी रोशनी में सीधा रखें" },
    mr: { hold: "कागद कॅमेऱ्यासमोर धरा", show: "मला कागद दाखवा", reading: "तुमचा कागद वाचत आहे", ready: "मी वाचले आहे. तुम्हाला काय जाणून घ्यायचे आहे?", unclear: "हे स्पष्ट वाचता आले नाही, चांगल्या प्रकाशात सरळ धरा" },
    ta: { hold: "ஆவணத்தை கேமரா முன் பிடியுங்கள்", show: "ஆவணத்தைக் காட்டுங்கள்", reading: "உங்கள் ஆவணத்தைப் படிக்கிறேன்", ready: "நான் படித்துவிட்டேன். என்ன தெரிந்துகொள்ள வேண்டும்?", unclear: "தெளிவாகப் படிக்க முடியவில்லை, நல்ல வெளிச்சத்தில் நேராகப் பிடியுங்கள்" },
    kn: { hold: "ದಾಖಲೆಯನ್ನು ಕ್ಯಾಮೆರಾ ಮುಂದೆ ಹಿಡಿಯಿರಿ", show: "ನನಗೆ ದಾಖಲೆಯನ್ನು ತೋರಿಸಿ", reading: "ನಿಮ್ಮ ದಾಖಲೆಯನ್ನು ಓದುತ್ತಿದ್ದೇನೆ", ready: "ನಾನು ಓದಿದ್ದೇನೆ. ನಿಮಗೆ ಏನು ತಿಳಿಯಬೇಕು?", unclear: "ಇದನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ಓದಲಾಗಲಿಲ್ಲ, ಉತ್ತಮ ಬೆಳಕಿನಲ್ಲಿ ನೇರವಾಗಿ ಹಿಡಿಯಿರಿ" },
    bn: { hold: "নথিটি ক্যামেরার সামনে ধরুন", show: "আমাকে নথিটি দেখান", reading: "আপনার নথিটি পড়ছি", ready: "আমি পড়েছি। আপনি কী জানতে চান?", unclear: "এটি স্পষ্ট পড়তে পারিনি, ভালো আলোতে সোজা করে ধরুন" },
    gu: { hold: "દસ્તાવેજ કેમેરા સામે રાખો", show: "મને દસ્તાવેજ બતાવો", reading: "હું તમારો દસ્તાવેજ વાંચી રહ્યો છું", ready: "મેં વાંચી લીધું છે. તમે શું જાણવા માંગો છો?", unclear: "હું આ સ્પષ્ટ વાંચી શક્યો નહીં, સારા પ્રકાશમાં સીધું રાખો" },
    ml: { hold: "രേഖ ക്യാമറയ്ക്ക് മുന്നിൽ പിടിക്കുക", show: "എനിക്ക് രേഖ കാണിക്കുക", reading: "നിങ്ങളുടെ രേഖ വായിക്കുന്നു", ready: "ഞാൻ വായിച്ചു. നിങ്ങൾക്ക് എന്താണ് അറിയേണ്ടത്?", unclear: "ഇത് വ്യക്തമായി വായിക്കാനായില്ല, നല്ല വെളിച്ചത്തിൽ നേരെ പിടിക്കുക" },
    pa: { hold: "ਦਸਤਾਵੇਜ਼ ਕੈਮਰੇ ਸਾਹਮਣੇ ਰੱਖੋ", show: "ਮੈਨੂੰ ਦਸਤਾਵੇਜ਼ ਦਿਖਾਓ", reading: "ਮੈਂ ਤੁਹਾਡਾ ਦਸਤਾਵੇਜ਼ ਪੜ੍ਹ ਰਿਹਾ ਹਾਂ", ready: "ਮੈਂ ਪੜ੍ਹ ਲਿਆ ਹੈ। ਤੁਸੀਂ ਕੀ ਜਾਣਨਾ ਚਾਹੁੰਦੇ ਹੋ?", unclear: "ਮੈਂ ਇਸਨੂੰ ਸਾਫ਼ ਨਹੀਂ ਪੜ੍ਹ ਸਕਿਆ, ਚੰਗੀ ਰੌਸ਼ਨੀ ਵਿੱਚ ਸਿੱਧਾ ਰੱਖੋ" },
    or: { hold: "ଦଲିଲକୁ କ୍ୟାମେରା ସାମ୍ନାରେ ଧରନ୍ତୁ", show: "ମୋତେ ଦଲିଲ ଦେଖାନ୍ତୁ", reading: "ଆପଣଙ୍କ ଦଲିଲ ପଢୁଛି", ready: "ମୁଁ ପଢିଛି। ଆପଣ କଣ ଜାଣିବାକୁ ଚାହୁଁଛନ୍ତି?", unclear: "ମୁଁ ଏହା ସ୍ପଷ୍ଟ ପଢିପାରିଲି ନାହିଁ, ଭଲ ଆଲୋକରେ ସିଧା ଧରନ୍ତୁ" },
  })[0];

  const getAudioContext = useCallback(() => {
    const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("Web Audio is not supported in this browser");
    if (!audioContextRef.current) audioContextRef.current = new AudioContextConstructor();
    return audioContextRef.current;
  }, []);

  const playCue = useCallback((notes: number[], duration: number, volume = 0.08, noise = false) => {
    if (!soundOn) return;
    try {
      const context = getAudioContext(); const now = context.currentTime;
      notes.forEach((frequency, index) => {
        const gain = context.createGain(); const start = now + index * duration;
        gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(volume, start + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        if (noise) { const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate); const values = buffer.getChannelData(0); values.forEach((_, sample) => { values[sample] = Math.random() * 2 - 1; }); const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain); gain.connect(context.destination); source.start(start); }
        else { const oscillator = context.createOscillator(); oscillator.type = "sine"; oscillator.frequency.value = frequency; oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + duration + 0.01); }
      });
    } catch { /* Audio is unlocked by the existing mic/orb gesture. */ }
  }, [getAudioContext, soundOn]);

  useEffect(() => {
    if (orbState !== "processing" || activeService === "VISION") return;
    const interval = window.setInterval(() => { setThinkingStage((stage) => (stage + 1) % 3); playCue([220], 0.08, 0.03); }, 1200);
    return () => window.clearInterval(interval);
  }, [activeService, orbState, playCue]);

  const setService = (service: StackService | null) => setActiveService(service);

  const patchActiveSession = useCallback((patch: Partial<Session>) => {
    const id = activeSessionIdRef.current;
    if (!id) return;
    setSessions((current) =>
      current.map((session) =>
        session.id === id ? { ...session, ...patch, updatedAt: Date.now() } : session,
      ),
    );
  }, []);

  const getHistoryPayload = useCallback(() => {
    const session = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
    return historyForApi(session?.turns ?? []);
  }, []);

  const addTurn = useCallback((turn: {
    userText: string;
    setuText: string;
    language: Language;
    evidence?: { page: number; quote: string }[];
    docId?: string;
  }) => {
    const now = Date.now();
    const userTurn: Turn = { id: crypto.randomUUID(), role: "user", text: turn.userText, language: turn.language, timestamp: now };
    const setuTurn: Turn = {
      id: crypto.randomUUID(),
      role: "setu",
      text: turn.setuText,
      language: turn.language,
      evidence: turn.evidence,
      timestamp: now,
    };
    let id = activeSessionIdRef.current;
    if (!id || !sessionsRef.current.some((session) => session.id === id)) {
      const session = makeSession(turn.language);
      id = session.id;
      activeSessionIdRef.current = id;
      setActiveSessionId(id);
      setSessions([{
        ...session,
        turns: [userTurn, setuTurn],
        title: titleFromTurns([userTurn, setuTurn]),
        updatedAt: now,
        language: turn.language,
        docId: turn.docId ?? null,
      }, ...sessionsRef.current]);
      return;
    }
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== id) return session;
        const turns = [...session.turns, userTurn, setuTurn];
        return {
          ...session,
          turns,
          title: titleFromTurns(turns),
          updatedAt: now,
          language: turn.language,
          docId: turn.docId !== undefined ? turn.docId : session.docId,
        };
      }),
    );
  }, []);

  const startNewChat = useCallback(() => {
    const session = makeSession(languageRef.current);
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id;
    setDocId(null);
    docIdRef.current = null;
    setTranscript("");
    setAnswerSheet(null);
    setShowProof(false);
    setStatusText("Tap to speak");
    setIsHistoryOpen(false);
  }, []);

  const loadSession = useCallback((id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id);
    if (!session) return;
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id;
    setDocId(session.docId);
    docIdRef.current = session.docId;
    setLanguage(session.language);
    languageRef.current = session.language;
    setTranscript("");
    setAnswerSheet(null);
    setShowProof(false);
    setStatusText("Tap to speak");
    setIsHistoryOpen(false);
    console.info("[Setu session] loaded", { id: session.id, docId: session.docId, turns: session.turns.length });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== id);
      if (activeSessionIdRef.current !== id) return remaining;
      const next = remaining[0] ?? makeSession(languageRef.current);
      const list = remaining.length ? remaining : [next];
      const active = list[0];
      queueMicrotask(() => {
        setActiveSessionId(active.id);
        activeSessionIdRef.current = active.id;
        setDocId(active.docId);
        docIdRef.current = active.docId;
        setLanguage(active.language);
        languageRef.current = active.language;
        setTranscript("");
        setAnswerSheet(null);
        setShowProof(false);
      });
      return list;
    });
  }, []);

  const clearAllSessions = useCallback(() => {
    const session = makeSession(languageRef.current);
    setSessions([session]);
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id;
    setDocId(null);
    docIdRef.current = null;
    setTranscript("");
    setAnswerSheet(null);
    setShowProof(false);
  }, []);

  const playSpeech = useCallback(async (text: string, selectedLanguage: Language, continueListening = false, voice = speaker, cachedUrl?: string, onEnded?: () => void) => {
    setService("BULBUL");
    setOrbState("processing");
    setStatusText("Preparing a response");
    try {
      let url = cachedUrl;
      if (!url) {
        const speakStarted = performance.now();
        const response = await fetch(`${API_URL}/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, language: selectedLanguage, speaker: voice, pace }) });
        const speakMs = Math.round(performance.now() - speakStarted);
        logStageTiming("speak", speakMs);
        turnTimingRef.current.speak += speakMs;
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          console.error(`[speak] failed language=${selectedLanguage} speaker=${voice} status=${response.status} ${detail}`);
          throw new Error(`Speech unavailable for ${LANGUAGE_LABELS[selectedLanguage] ?? selectedLanguage}`);
        }
        url = URL.createObjectURL(await response.blob());
      }
      const audio = new Audio(url);
      audioRef.current?.pause();
      audioRef.current = audio;
      const context = getAudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const source = context.createMediaElementSource(audio);
      audioSourceRef.current = source;
      source.connect(analyser);
      analyser.connect(context.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const animate = () => { analyser.getByteFrequencyData(data); const normal = (from: number, to: number) => data.slice(from, to).reduce((sum, value) => sum + value, 0) / Math.max(1, to - from) / 255; setAmplitude(data.reduce((sum, value) => sum + value, 0) / data.length / 255); setBands({ bass: normal(0, Math.floor(data.length * 0.18)), treble: normal(Math.floor(data.length * 0.62), data.length) }); setSpectrum(Array.from({ length: 8 }, (_, index) => normal(Math.floor(data.length * index / 8), Math.floor(data.length * (index + 1) / 8)))); if (!audio.paused && !audio.ended) requestAnimationFrame(animate); };
      audio.onplay = () => { setOrbState("speaking"); setStatusText("Speaking"); animate(); };
      audio.onended = () => { setAmplitude(0.2); setBands({ bass: 0, treble: 0 }); setSpectrum(Array.from({ length: 8 }, () => 0)); setPreviewingVoice(null); setOrbState("idle"); setStatusText("Tap to speak"); setService(null); if (!cachedUrl) URL.revokeObjectURL(url); onEnded?.(); if (continueListening) startRecordingRef.current?.(); };
      await context.resume();
      await audio.play();
    } catch (error) {
      console.error(`[speak] language=${selectedLanguage} speaker=${voice}`, error);
      setStatusText(error instanceof Error ? error.message : "Unable to play speech");
      setOrbState("idle"); setService(null);
    }
  }, [getAudioContext, pace, speaker]);

  const converse = useCallback(async (message: string, selectedLanguage: Language, hasDocument: boolean) => {
    const payload = { message, language: selectedLanguage, has_document: hasDocument, history: getHistoryPayload() };
    console.info("[Setu /converse]", payload);
    const converseStarted = performance.now();
    const response = await fetch(`${API_URL}/converse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const converseMs = Math.round(performance.now() - converseStarted);
    logStageTiming("converse", converseMs);
    turnTimingRef.current.converse += converseMs;
    if (!response.ok) throw new Error("Conversation service unavailable");
    return response.json() as Promise<{ reply: string; intent: "chat" | "needs_document" | "document_question" }>;
  }, [getHistoryPayload]);

  const clearDocument = useCallback(() => {
    setDocId(null);
    docIdRef.current = null;
    patchActiveSession({ docId: null });
  }, [patchActiveSession]);

  const askDocument = useCallback(async (activeDocId: string, question: string, answerLanguage: Language) => {
    const payload = { doc_id: activeDocId, question, answer_language: answerLanguage, history: getHistoryPayload() };
    console.info("[Setu routing] /ask", payload);
    const askStarted = performance.now();
    const response = await fetch(`${API_URL}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const askMs = Math.round(performance.now() - askStarted);
    logStageTiming("ask", askMs);
    turnTimingRef.current.ask += askMs;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[Setu /ask] failed", response.status, detail);
      if (response.status === 404) clearDocument();
      throw new Error(response.status === 404 ? "Document expired — show it again" : "Document answer service unavailable");
    }
    return response.json() as Promise<{ answer: string; evidence?: { page: number; quote: string }[] }>;
  }, [clearDocument, getHistoryPayload]);

  const closeCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    cameraGoodChecksRef.current = 0;
    setCameraOpen(false); setCameraReadiness(0);
  }, []);

  const scanDocument = useCallback(async (blob: Blob) => {
    const activeLanguage = languageRef.current;
    turnTimingRef.current = emptyTurnTiming();
    setOrbState("processing"); setStatusText(cameraText[activeLanguage].reading); setService("BULBUL");
    await playSpeech(cameraText[activeLanguage].reading, activeLanguage, false, speaker, undefined, async () => {
      setService("VISION");
      const started = performance.now();
      let progressLabel = cameraText[activeLanguage].reading;
      const clock = window.setInterval(() => {
        const elapsed = Math.floor((performance.now() - started) / 1000);
        setStatusText(`${progressLabel} · ${elapsed}s`);
      }, 250);
      try {
        const form = new FormData(); form.append("file", blob, "setu-document.jpg"); form.append("language", `${activeLanguage}-IN`);
        const scanStarted = performance.now();
        const response = await fetch(`${API_URL}/scan`, { method: "POST", body: form });
        if (!response.ok || !response.body) throw new Error("Document scan failed");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result: { doc_id?: string; status?: string; pages?: number; cached?: boolean } | null = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as {
              type?: string;
              message?: string;
              doc_id?: string;
              status?: string;
              pages?: number;
              cached?: boolean;
              detail?: string;
            };
            if (event.type === "progress" && event.message) {
              progressLabel = event.message;
              const elapsed = Math.floor((performance.now() - started) / 1000);
              setStatusText(`${progressLabel} · ${elapsed}s`);
              console.info("[scan]", event.message);
            } else if (event.type === "done") {
              result = event;
            } else if (event.type === "unclear_scan") {
              result = { status: "unclear_scan" };
            } else if (event.type === "error") {
              throw new Error(event.detail || "Document scan failed");
            }
          }
        }
        const scanMs = Math.round(performance.now() - scanStarted);
        logStageTiming("scan", scanMs);
        console.log(`[scan] vision=${scanMs}ms`);
        window.clearInterval(clock); setService(null);
        if (!result || result.status === "unclear_scan" || !result.doc_id) {
          await playSpeech(cameraText[activeLanguage].unclear, activeLanguage, false, speaker, undefined, () => setCameraOpen(true));
          logTurnTiming(turnTimingRef.current);
          return;
        }
        setDocId(result.doc_id);
        docIdRef.current = result.doc_id;
        patchActiveSession({ docId: result.doc_id });
        console.info("[Setu document] stored docId on session after /scan", {
          docId: result.doc_id,
          pages: result.pages,
          sessionId: activeSessionIdRef.current,
          refNow: docIdRef.current,
        });
        // Scan already succeeded — summary /ask must not fail the whole flow.
        setService("105B");
        try {
          const summary = await askDocument(
            result.doc_id,
            "What is this document about? Answer in 2 sentences.",
            activeLanguage,
          );
          setService(null);
          addTurn({
            userText: "Scanned document",
            setuText: summary.answer,
            language: activeLanguage,
            docId: result.doc_id,
            evidence: summary.evidence,
          });
          await playSpeech(summary.answer, activeLanguage, false, speaker, undefined, async () => {
            await playSpeech(cameraText[activeLanguage].ready, activeLanguage, true);
            logTurnTiming(turnTimingRef.current);
          });
        } catch (summaryError) {
          console.warn("[Setu document] summary /ask failed; continuing", summaryError);
          setService(null);
          await playSpeech(cameraText[activeLanguage].ready, activeLanguage, true);
          logTurnTiming(turnTimingRef.current);
        }
      } catch (error) {
        window.clearInterval(clock); setService(null); setOrbState("idle"); setStatusText(error instanceof Error ? error.message : "Document scan failed");
        logTurnTiming(turnTimingRef.current);
      }
    });
  }, [addTurn, askDocument, cameraText, patchActiveSession, playSpeech, speaker]);

  const captureDocument = useCallback(() => {
    if (cameraCapturedRef.current) return;
    const video = cameraVideoRef.current; const canvas = cameraCanvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    cameraCapturedRef.current = true;
    playCue([1], 0.04, 0.08, true);
    const width = 1280; const height = Math.round(width * video.videoHeight / video.videoWidth);
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      console.log(`[capture] size=${blob.size} dims=${canvas.width}x${canvas.height}`);
      closeCamera();
      void scanDocument(blob);
    }, "image/jpeg", 0.9);
  }, [closeCamera, playCue, scanDocument]);

  useEffect(() => {
    if (!cameraOpen) return;
    cameraCapturedRef.current = false; cameraGoodChecksRef.current = 0;
    let interval = 0;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        cameraStreamRef.current = stream;
        const video = cameraVideoRef.current; if (!video) return;
        video.srcObject = stream;
        interval = window.setInterval(() => {
          const canvas = cameraCanvasRef.current;
          if (!canvas || !video.videoWidth || cameraCapturedRef.current) return;
          const width = 320; const height = Math.round(width * video.videoHeight / video.videoWidth);
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return;
          context.drawImage(video, 0, 0, width, height);
          const data = context.getImageData(0, 0, width, height).data;
          const analysis = analyzeDocumentFrame(data, width, height);
          cameraGoodChecksRef.current = analysis.passed
            ? Math.min(CAPTURE_STREAK, cameraGoodChecksRef.current + 1)
            : 0;
          setCameraReadiness(cameraGoodChecksRef.current);
          console.info(
            `[capture] edgeDensity=${analysis.edgeDensity.toFixed(3)} brightnessVar=${analysis.brightnessVariance.toFixed(1)} ` +
              `peak=${analysis.peak.toFixed(3)} bestBlock=${analysis.bestBlock.toFixed(3)} ` +
              `hot=${analysis.hotCells} blob=${analysis.largestBlob} passed=${analysis.passed} ` +
              `streak=${cameraGoodChecksRef.current}/${CAPTURE_STREAK}`,
          );
          if (cameraGoodChecksRef.current === CAPTURE_STREAK) captureDocument();
        }, 500);
      })
      .catch(() => { setStatusText("Camera permission is required"); setCameraOpen(false); });
    return () => { window.clearInterval(interval); cameraStreamRef.current?.getTracks().forEach((track) => track.stop()); cameraStreamRef.current = null; };
  }, [cameraOpen, captureDocument]);

  const finishRecording = useCallback(async (cancelled = false) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    cancelAnimationFrame(recorder.raf); recorder.processor.disconnect(); recorder.silenceGain.disconnect(); recorder.source.disconnect(); recorder.stream.getTracks().forEach((track) => track.stop());
    setIsRecording(false); setAmplitude(0.2); setBands({ bass: 0, treble: 0 }); setAutoStopProgress(0); setMicLevel(0);
    playCue([660, 440], 0.12, 0.07);
    if (cancelled || !recorder.heardSpeech) { setOrbState("idle"); setStatusText("I did not hear anything. Try again."); return; }
    setOrbState("processing"); setStatusText("Hearing you"); setService("SAARAS");
    turnTimingRef.current = emptyTurnTiming();
    try {
      // Never pin STT to the active reply language — that blocks switches like "Marathi".
      const form = new FormData(); form.append("file", encodeWav(recorder.chunks, recorder.sampleRate), "setu-question.wav");
      const listenStarted = performance.now();
      const listenResponse = await fetch(`${API_URL}/listen`, { method: "POST", body: form });
      const listenMs = Math.round(performance.now() - listenStarted);
      logStageTiming("listen", listenMs);
      turnTimingRef.current.listen += listenMs;
      if (!listenResponse.ok) throw new Error("Transcription service unavailable");
      const listenResult = await listenResponse.json() as { transcript: string; language_code?: string };
      const heard = listenResult.transcript.trim();
      setService(null); setTranscript(heard);
      if (!heard) throw new Error("I could not understand that. Try again.");
      const detected = listenResult.language_code?.toLowerCase().split("-", 1)[0] || "unknown";
      const requestedLanguage = explicitLanguage(heard);
      const activeLanguage = languageRef.current;
      // Explicit name always wins (even after lock). Otherwise keep lock, or auto-detect on first turns.
      const resolvedLanguage = requestedLanguage
        ?? (languageLockedRef.current ? activeLanguage : resolveLanguage(heard, listenResult.language_code));
      console.info(
        `[lang] transcript=${JSON.stringify(heard)} detected=${detected} requested=${requestedLanguage ?? "none"} active=${activeLanguage} next=${resolvedLanguage}`,
      );
      setLanguage(resolvedLanguage);
      languageRef.current = resolvedLanguage;
      languageLockedRef.current = true;
      patchActiveSession({ language: resolvedLanguage });
      setStatusText("Thinking");
      const loadedDocId = docIdRef.current;
      const hasDocument = Boolean(loadedDocId);
      const smallTalk = isClearSmallTalk(heard);
      const showDocument = WANTS_TO_SHOW_DOCUMENT.test(heard) || DOCUMENT_MENTION.test(heard);
      console.info("[Setu routing] turn", {
        docId: loadedDocId,
        has_document: hasDocument,
        smallTalk,
        showDocument,
        transcript: heard,
        language: resolvedLanguage,
      });

      // "I have a document" / show-it phrases → camera, never /ask.
      if (showDocument && (WANTS_TO_SHOW_DOCUMENT.test(heard) || !loadedDocId)) {
        console.info("[Setu routing] branch=open-camera", { reason: "user wants to show a document" });
        addTurn({ userText: heard, setuText: cameraText[resolvedLanguage].show, language: resolvedLanguage });
        await playSpeech(cameraText[resolvedLanguage].show, resolvedLanguage, false, speaker, undefined, () => setCameraOpen(true));
        logTurnTiming(turnTimingRef.current);
        return;
      }

      // Document loaded → /ask for all substantive turns. Never trust model intent alone.
      if (loadedDocId && !smallTalk) {
        console.info("[Setu routing] branch=/ask", { docId: loadedDocId, reason: "document loaded, substantive question" });
        setService("105B");
        try {
          const answer = await askDocument(loadedDocId, heard, resolvedLanguage);
          setService(null);
          setAnswerSheet({ answer: answer.answer, evidence: answer.evidence ?? [], verified: true }); setShowProof(false); playCue([523, 659, 784], 0.06, 0.09);
          addTurn({ userText: heard, setuText: answer.answer, language: resolvedLanguage, docId: loadedDocId, evidence: answer.evidence });
          await playSpeech(answer.answer, resolvedLanguage, true);
        } catch (askError) {
          setService(null);
          console.error("[Setu routing] /ask error", askError);
          setOrbState("idle");
          setStatusText(askError instanceof Error ? askError.message : "Could not answer from the document");
        }
        logTurnTiming(turnTimingRef.current);
        return;
      }

      console.info("[Setu routing] branch=/converse", {
        has_document: hasDocument,
        reason: loadedDocId ? "small talk with document" : "no document",
      });
      const chat = await converse(heard, resolvedLanguage, hasDocument);
      console.info("[Setu /converse] response", { intent: chat.intent, reply: chat.reply, has_document: hasDocument });

      if (!loadedDocId && (chat.intent === "needs_document" || DOCUMENT_MENTION.test(heard))) {
        console.info("[Setu routing] branch=open-camera", { intent: chat.intent });
        addTurn({ userText: heard, setuText: chat.reply, language: resolvedLanguage });
        await playSpeech(cameraText[resolvedLanguage].show, resolvedLanguage, false, speaker, undefined, () => setCameraOpen(true));
        logTurnTiming(turnTimingRef.current);
        return;
      }

      addTurn({ userText: heard, setuText: chat.reply, language: resolvedLanguage, ...(loadedDocId ? { docId: loadedDocId } : {}) });
      await playSpeech(chat.reply, resolvedLanguage, true);
      logTurnTiming(turnTimingRef.current);
    } catch (error) {
      setService(null);
      setOrbState("idle");
      setStatusText(error instanceof Error ? error.message : "Something went wrong");
      logTurnTiming(turnTimingRef.current);
    }
  }, [addTurn, askDocument, cameraText, converse, patchActiveSession, playCue, playSpeech, speaker]);

  const startRecording = useCallback(async () => {
    if (isRecording) { void finishRecording(); return; }
    try {
      const context = getAudioContext(); await context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser(); analyser.fftSize = 256;
      const processor = context.createScriptProcessor(4096, 1, 1); const silenceGain = context.createGain(); silenceGain.gain.value = 0;
      source.connect(analyser); source.connect(processor); processor.connect(silenceGain); silenceGain.connect(context.destination);
      const recorder = {
        stream,
        source,
        analyser,
        processor,
        silenceGain,
        chunks: [] as Float32Array[],
        sampleRate: context.sampleRate,
        startedAt: performance.now(),
        heardSpeech: false,
        silentSince: null as number | null,
        raf: 0,
        speechThreshold: SPEECH_LEVEL,
        ambientSum: 0,
        ambientCount: 0,
        thresholdLocked: false,
        lastLogAt: 0,
      };
      recorderRef.current = recorder;
      setTranscript("");
      setIsRecording(true); playCue([440, 660], 0.12, 0.07);
      setOrbState("listening");
      setStatusText("I am listening…");
      setAutoStopProgress(0);
      setMicLevel(0);
      setMicThreshold(SPEECH_LEVEL);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const animate = () => {
        analyser.getByteFrequencyData(frequencyData);
        const normal = (from: number, to: number) => frequencyData.slice(from, to).reduce((sum, value) => sum + value, 0) / Math.max(1, to - from) / 255;
        setAmplitude(frequencyData.reduce((sum, value) => sum + value, 0) / frequencyData.length / 255);
        setBands({ bass: normal(0, Math.floor(frequencyData.length * 0.18)), treble: normal(Math.floor(frequencyData.length * 0.62), frequencyData.length) });
        setSpectrum(Array.from({ length: 8 }, (_, index) => normal(Math.floor(frequencyData.length * index / 8), Math.floor(frequencyData.length * (index + 1) / 8))));
        if (recorderRef.current === recorder) recorder.raf = requestAnimationFrame(animate);
      };
      animate();
      processor.onaudioprocess = (event) => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        recorder.chunks.push(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const now = performance.now();
        const elapsed = now - recorder.startedAt;

        if (!recorder.thresholdLocked) {
          if (elapsed < AMBIENT_MS) {
            recorder.ambientSum += rms;
            recorder.ambientCount += 1;
          } else {
            const ambient = recorder.ambientCount ? recorder.ambientSum / recorder.ambientCount : 0;
            // Cap at 0.05 — noisy buses raise ambient so high speech never crosses the floor.
            recorder.speechThreshold = Math.min(Math.max(ambient * 2.5, SPEECH_LEVEL), 0.05);
            recorder.thresholdLocked = true;
            setMicThreshold(recorder.speechThreshold);
            console.info("[Setu mic] auto-gain", {
              ambient: Number(ambient.toFixed(5)),
              speechThreshold: Number(recorder.speechThreshold.toFixed(5)),
              capped: ambient * 2.5 > 0.05,
            });
          }
        }

        const isSpeech = rms >= recorder.speechThreshold;
        if (isSpeech) {
          recorder.heardSpeech = true;
          recorder.silentSince = null;
          setAutoStopProgress(0);
        } else if (recorder.heardSpeech && elapsed >= MIN_RECORDING_MS) {
          recorder.silentSince ??= now;
          const silentFor = now - recorder.silentSince;
          setAutoStopProgress(Math.max(0, (silentFor - (SILENCE_MS - 600)) / 600));
          if (silentFor >= SILENCE_MS) void finishRecording();
        }

        if (now - recorder.lastLogAt >= 100) {
          recorder.lastLogAt = now;
          setMicLevel(rms);
          console.info("[Setu mic]", {
            rms: Number(rms.toFixed(5)),
            heardSpeech: recorder.heardSpeech,
            elapsedMs: Math.round(elapsed),
            threshold: Number(recorder.speechThreshold.toFixed(5)),
            speechNow: isSpeech,
          });
        }

        if (!recorder.heardSpeech && elapsed >= NO_SPEECH_MS) void finishRecording(true);
      };
    } catch (error) { setOrbState("idle"); setStatusText(error instanceof Error ? "Microphone permission is required" : "Unable to start microphone"); }
  }, [finishRecording, getAudioContext, isRecording, playCue]);

  useEffect(() => {
    startRecordingRef.current = () => void startRecording();
  }, [startRecording]);

  const beginOrStop = async () => {
    if (isRecording) { void finishRecording(); return; }
    if (orbState === "speaking") { audioRef.current?.pause(); setAmplitude(0.2); setBands({ bass: 0, treble: 0 }); setOrbState("idle"); setStatusText("Tap to begin"); setService(null); return; }
    if (hasStarted) { void startRecording(); return; }
    setHasStarted(true); setOrbState("processing"); setStatusText("Welcome to Setu");
    try { await getAudioContext().resume(); const greeting = await converse("greet the user and ask which language they want to speak in", "en", false); addTurn({ userText: "Start conversation", setuText: greeting.reply, language: "en" }); await playSpeech(greeting.reply, "en", true); }
    catch { setOrbState("idle"); setStatusText("Tap to begin"); }
  };

  const openSettings = async () => {
    setIsSettingsOpen(true);
    if (voices.length) return;
    try { const response = await fetch(`${API_URL}/voices`); if (response.ok) setVoices(await response.json() as string[]); } catch { /* The drawer can still show the current voice. */ }
  };

  const selectVoice = async (voice: string) => {
    audioRef.current?.pause();
    setSpeaker(voice);
    setPreviewingVoice(voice);
    const samples: Record<Language, string> = { te: "నమస్కారం, నేను సేతు", hi: "नमस्ते, मैं सेतु हूँ", en: "Hello, I am Setu", mr: "नमस्कार, मी सेतू आहे", ta: "வணக்கம், நான் சேது", kn: "ನಮಸ್ಕಾರ, ನಾನು ಸೇತು", bn: "নমস্কার, আমি সেতু", gu: "નમસ્તે, હું સેતુ છું", ml: "നമസ്കാരം, ഞാൻ സേതു", pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ਸੇਤੂ ਹਾਂ", or: "ନମସ୍କାର, ମୁଁ ସେତୁ" };
    try {
      let url = previewCacheRef.current.get(voice);
      if (!url) {
        const response = await fetch(`${API_URL}/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: samples[language], language, speaker: voice, pace }) });
        if (!response.ok) throw new Error("Speech service unavailable");
        url = URL.createObjectURL(await response.blob());
        previewCacheRef.current.set(voice, url);
      }
      await playSpeech("", language, false, voice, url);
    } catch { setPreviewingVoice(null); }
  };

  useEffect(() => {
    const restore = window.setTimeout(() => {
      const { sessions: restored, activeId } = loadSessionsFromStorage(languageRef.current);
      setSessions(restored);
      setActiveSessionId(activeId);
      activeSessionIdRef.current = activeId;
      sessionsRef.current = restored;
      const active = restored.find((session) => session.id === activeId) ?? restored[0];
      if (active) {
        setDocId(active.docId);
        docIdRef.current = active.docId;
        setLanguage(active.language);
        languageRef.current = active.language;
      }
      setSessionsLoaded(true);
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => {
    if (!sessionsLoaded) return;
    localStorage.setItem("setu-sessions", JSON.stringify(sessions));
    if (activeSessionId) localStorage.setItem("setu-active-session", activeSessionId);
  }, [sessions, activeSessionId, sessionsLoaded]);

  useEffect(() => () => { recorderRef.current?.stream.getTracks().forEach((track) => track.stop()); audioRef.current?.pause(); previewCacheRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  const displayStatus = orbState === "processing" && activeService !== "VISION"
    ? ["Reading", "Understanding", "Preparing the answer"][thinkingStage]
    : statusText;

  return (
    <main className="relative isolate flex min-h-dvh w-full justify-center overflow-hidden bg-[#faf8f5] px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-[#172033]">
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46%] bg-[radial-gradient(ellipse_at_50%_0%,#fff7ed_0%,#faf8f5_55%,transparent_100%)]" />
      <div aria-hidden className="setu-wave-bg pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[58%]">
        <img src="/bg-waves.png" alt="" className="absolute inset-0 h-full w-full object-cover object-bottom" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#faf8f5] via-[#faf8f5]/55 to-transparent" />
      </div>
      <div className="relative z-0 flex w-full max-w-md flex-col">
        <header className="glass-surface flex h-14 shrink-0 items-center justify-between rounded-full px-2.5 shadow-[0_8px_32px_rgba(71,85,105,0.07)]"><button onClick={() => setIsHistoryOpen(true)} aria-label="Open chats" className="icon-button"><Menu size={19} strokeWidth={1.8} /></button><div className="flex items-center gap-2" aria-label="Setu"><img src="/logo.png" alt="Setu" width={117} height={64} className="h-8 w-auto select-none" draggable={false} /><span className="font-display text-[26px] leading-none tracking-[-0.04em]">Setu</span></div><button onClick={() => void openSettings()} aria-label="Open settings" className="icon-button"><Settings2 size={18} strokeWidth={1.8} /></button></header>
        <section className="flex flex-1 flex-col items-center justify-center pb-5 pt-8">
          <SetuOrb orbState={orbState} amplitude={amplitude} bass={bands.bass} treble={bands.treble} spectrum={spectrum} autoStopProgress={autoStopProgress} onClick={() => void beginOrStop()} />
          {isRecording && (
            <div className="mt-5 w-44" aria-label="Microphone level">
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/80">
                <div
                  className="h-full rounded-full bg-[#ff6b00] transition-[width] duration-75"
                  style={{ width: `${Math.min(100, (micLevel / Math.max(micThreshold, SPEECH_LEVEL)) * 55)}%` }}
                />
              </div>
              <p className="mt-1 text-center text-[10px] tabular-nums text-slate-400">
                rms {micLevel.toFixed(3)} · thr {micThreshold.toFixed(3)}
              </p>
            </div>
          )}
          <AnimatePresence mode="wait"><motion.p key={displayStatus || "status"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22 }} className={`${isRecording ? "mt-4" : "mt-8"} text-center text-sm font-medium tracking-[-0.01em] text-slate-700`}>{displayStatus}</motion.p></AnimatePresence>
          {transcript && <motion.p variants={{ show: { transition: { staggerChildren: 0.03 } } }} initial="hidden" animate="show" className="mt-2 max-w-xs text-center text-xs leading-5 text-slate-500">Heard: {transcript.split(/\s+/).filter(Boolean).map((word, index) => <motion.span key={`heard-${index}`} variants={{ hidden: { opacity: 0, y: 4 }, show: { opacity: 1, y: 0 } }} className="mr-1 inline-block">{word}</motion.span>)}</motion.p>}
        </section>
        <div
          className="setu-composer glass-surface glass-on-waves mb-3 flex h-14 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-1.5 shadow-[0_10px_28px_rgba(71,85,105,0.10)]"
          data-document-loaded={docId ? "true" : "false"}
        >
          <button
            onClick={() => setCameraOpen(true)}
            aria-label={docId ? "Replace loaded document" : "Add a document"}
            className="icon-button shrink-0 text-[#4f46e5]"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => void beginOrStop()}
            className="min-w-0 flex-1 truncate px-1 text-left text-[13px] leading-5 text-slate-500 transition hover:text-slate-700"
          >
            {isRecording ? "Listening…" : docId ? "Ask about this document" : "Tap to speak with Setu"}
          </button>
          <button
            onClick={() => void beginOrStop()}
            aria-label={isRecording ? "Stop recording" : "Start voice conversation"}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-white transition hover:scale-[1.03] active:scale-95 ${isRecording ? "bg-[#172033] shadow-[0_8px_18px_rgba(23,32,51,0.28)]" : "bg-[#ff6b00] shadow-[0_8px_18px_rgba(255,107,0,0.32)]"}`}
          >
            {isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={20} strokeWidth={2} />}
          </button>
        </div>
        <footer className="flex shrink-0 items-center justify-center gap-2 pb-1 text-[9px] font-semibold tracking-[0.16em]">{(["VISION", "105B", "BULBUL", "SAARAS"] as StackService[]).map((service, index) => <span key={service} className={activeService === service ? "text-[#ff6b00]" : "text-slate-500"}>{index > 0 && <span className="mr-2 text-slate-400">·</span>}{service}</span>)}</footer>
      </div>
      <AnimatePresence>{answerSheet && <motion.section key="answer-sheet" className="absolute inset-x-0 bottom-0 z-[15] rounded-t-[32px] bg-white/95 p-6 shadow-[0_-18px_50px_rgba(15,23,42,.18)] backdrop-blur-xl" initial={{ y: "110%" }} animate={{ y: 0 }} exit={{ y: "110%" }} transition={{ type: "spring", stiffness: 300, damping: 22 }}><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold text-[#059669]"><motion.span initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} className="grid h-6 w-6 place-items-center rounded-full border border-[#059669]"><Check size={15} /></motion.span> Verified from document</div><button onClick={() => setAnswerSheet(null)} className="icon-button"><X size={18} /></button></div><motion.p variants={{ show: { transition: { staggerChildren: 0.03 } } }} initial="hidden" animate="show" className="mt-5 text-[17px] leading-7 text-slate-800">{answerSheet.answer.split(/\s+/).filter(Boolean).map((word, index) => <motion.span key={`ans-${index}`} variants={{ hidden: { opacity: 0, y: 4 }, show: { opacity: 1, y: 0 } }} className="mr-1 inline-block">{word}</motion.span>)}</motion.p>{answerSheet.evidence.length > 0 && <><button onClick={() => setShowProof((shown) => !shown)} className="mt-5 text-sm font-semibold text-[#4f46e5]">Show proof</button><AnimatePresence>{showProof && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-3 space-y-2 overflow-hidden">{answerSheet.evidence.map((evidence, index) => <motion.div key={`${evidence.page}-${index}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-900"><span className="font-semibold">Page {evidence.page}</span><p className="mt-1">{evidence.quote}</p></motion.div>)}</motion.div>}</AnimatePresence></>}</motion.section>}</AnimatePresence>
      <AnimatePresence>{cameraOpen && <motion.section key="camera-overlay" className="absolute inset-0 z-20 bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><video ref={cameraVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" /><canvas ref={cameraCanvasRef} className="hidden" /><div className="absolute inset-0 flex flex-col items-center justify-between bg-gradient-to-b from-black/45 via-transparent to-black/60 p-6 text-center text-white"><p className="mt-4 max-w-xs text-lg font-medium">{cameraText[language].hold}</p><div className="grid h-16 w-16 place-items-center rounded-full border-2 border-white/80" style={{ background: `conic-gradient(#ff6b00 ${(cameraReadiness / CAPTURE_STREAK) * 100}%, rgba(255,255,255,.22) 0)` }}><span className="grid h-12 w-12 place-items-center rounded-full bg-black/55 text-xs">{cameraReadiness}/{CAPTURE_STREAK}</span></div><div className="flex w-full justify-between"><button onClick={closeCamera} className="rounded-full bg-black/45 px-5 py-3 text-sm backdrop-blur">Cancel</button><button onClick={captureDocument} className="rounded-full bg-[#ff6b00] px-5 py-3 text-sm font-medium">Capture now</button></div></div></motion.section>}</AnimatePresence>
      <AnimatePresence>{isSettingsOpen && <motion.button key="sound-toggle" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} onClick={() => setSoundOn((enabled) => !enabled)} className="absolute right-8 top-[232px] z-[11] flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700">{soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}{soundOn ? "Sound on" : "Muted"}</motion.button>}</AnimatePresence>
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.aside
            key="history-drawer"
            className="absolute inset-y-0 left-0 z-10 flex w-full max-w-none flex-col border-r border-slate-200/70 bg-white/90 p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[16px_0_48px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:w-[86%] sm:max-w-sm"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-3xl">Chats</h2>
              <button onClick={() => setIsHistoryOpen(false)} aria-label="Close chats" className="icon-button"><X size={20} /></button>
            </div>
            <button
              type="button"
              onClick={startNewChat}
              className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-[#ff6b00] py-3 text-sm font-medium text-white shadow-[0_10px_24px_rgba(255,107,0,0.28)]"
            >
              <MessageSquarePlus size={18} strokeWidth={2} />
              New chat
            </button>
            <div className="mt-6 flex-1 overflow-y-auto pr-1">
              {groupSessionsByDay(sessions).map(([day, daySessions]) => (
                <section key={day || "unknown-day"} className="mb-6">
                  <p className="text-xs font-semibold tracking-[0.12em] text-slate-400">{day}</p>
                  <div className="mt-2 space-y-2">
                    {daySessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        onSelect={() => loadSession(session.id)}
                        onDelete={() => deleteSession(session.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {sessions.length === 0 && <p className="pt-12 text-center text-sm text-slate-400">Your chats will appear here.</p>}
            </div>
            <button onClick={clearAllSessions} className="mt-4 min-h-11 w-full rounded-2xl border border-red-100 bg-red-50 py-3 text-sm font-medium text-red-600">Clear all</button>
          </motion.aside>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isSettingsOpen && (
          <motion.aside
            key="settings-drawer"
            className="absolute inset-y-0 right-0 z-10 flex w-full max-w-none flex-col border-l border-slate-200/70 bg-white/90 p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[-16px_0_48px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:w-[86%] sm:max-w-sm"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-3xl">Settings</h2>
              <button onClick={() => setIsSettingsOpen(false)} aria-label="Close settings" className="icon-button"><X size={20} /></button>
            </div>
            <div className="mt-8">
              <p className="text-xs font-semibold tracking-[0.14em] text-slate-400">LANGUAGE</p>
              <p className="mt-2 text-lg font-medium text-slate-700">{LANGUAGE_LABELS[language]}</p>
              <p className="mt-1 text-sm text-slate-400">Set by voice</p>
            </div>
            <div className="mt-8">
              <div className="flex justify-between">
                <p className="text-xs font-semibold tracking-[0.14em] text-slate-400">SPEECH SPEED</p>
                <span className="text-xs font-medium text-[#4f46e5]">{pace.toFixed(1)}×</span>
              </div>
              <input aria-label="Speech speed" className="mt-4 w-full accent-[#ff6b00]" type="range" min="0.5" max="2" step="0.1" value={pace} onChange={(event) => setPace(Number(event.target.value))} />
            </div>
            <div className="mt-8 min-h-0 flex-1">
              <p className="text-xs font-semibold tracking-[0.14em] text-slate-400">VOICE</p>
              <div className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
                {voices.length ? voices.map((voice) => (
                  <button
                    key={voice}
                    onClick={() => void selectVoice(voice)}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${speaker === voice ? "bg-[#4f46e5] text-white" : "hover:bg-[#fff7ed] text-slate-600"}`}
                  >
                    <span>{voice}</span>
                    {previewingVoice === voice && (
                      <motion.span
                        className="h-2 w-2 rounded-full bg-[#ff6b00]"
                        animate={{ scale: [1, 1.6] }}
                        transition={{ type: "tween", duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
                      />
                    )}
                  </button>
                )) : <p className="text-sm text-slate-400">Loading voices…</p>}
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </main>
  );
}
