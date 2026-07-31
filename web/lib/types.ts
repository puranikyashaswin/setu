export type Language = "te" | "hi" | "en" | "mr" | "ta" | "kn" | "bn" | "gu" | "ml" | "pa" | "or";
export type OrbState = "idle" | "listening" | "processing" | "speaking";
export type StackService = "VISION" | "CHAT" | "VOICE" | "LISTEN";
export type ChatRole = "user" | "setu";
export type EvidenceItem = { page: number; quote: string; verified: boolean };
export type Correction = { field: string; value: string; timestamp: number };
export type AskStatus = "verified_document" | "not_found" | "unclear_scan";
export type AskResponse = {
  answer: string;
  status: AskStatus;
  abstain: boolean;
  all_verified: boolean;
  evidence: EvidenceItem[];
  corrections: Correction[];
  action_items: string[];
  model_used?: string | null;
};
export type AskTurnMeta = {
  fromAsk: true;
  status: AskStatus;
  abstain: boolean;
  allVerified: boolean;
  actionItems: string[];
  corrections: Correction[];
};
export type TurnKind = "summary" | "answer";
export type Turn = {
  id: string;
  role: ChatRole;
  text: string;
  language: Language;
  evidence?: EvidenceItem[];
  askMeta?: AskTurnMeta;
  kind?: TurnKind;
  documentImage?: string;
  timestamp: number;
};
export type Session = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  language: Language;
  docId: string | null;
  documentName?: string | null;
  corrections?: Correction[];
  turns: Turn[];
  onboarded?: boolean;
  summary?: string | null;
};
export type AnswerSheet = AskResponse;
export type ApiHistoryMessage = { role: string; content: string; language?: Language };

export const LANGUAGE_LABELS: Record<Language, string> = {
  te: "Telugu",
  hi: "Hindi",
  en: "English",
  mr: "Marathi",
  ta: "Tamil",
  kn: "Kannada",
  bn: "Bengali",
  gu: "Gujarati",
  ml: "Malayalam",
  pa: "Punjabi",
  or: "Odia",
};
