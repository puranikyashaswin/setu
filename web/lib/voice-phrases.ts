export type PhraseLanguage =
  | "te"
  | "hi"
  | "en"
  | "mr"
  | "ta"
  | "kn"
  | "bn"
  | "gu"
  | "ml"
  | "pa"
  | "or";

/** Spoken on the very first tap (English). Then user picks a language. */
export const VOICE_LANGUAGE_PROMPT =
  "Hi, welcome to Setu. Which language do you prefer?";

/**
 * After the user picks a language — warm confirm in that language, then keep chatting.
 * Keep these short enough to speak quickly.
 */
export const SETU_INTRO_BY_LANG: Record<PhraseLanguage, string> = {
  en: "Great. I'm Setu. How can I help you?",
  te: "సరే. నేను సేతు. మీకు ఎలా సహాయం చేయగలను?",
  hi: "ठीक है. मैं सेतु हूँ. मैं आपकी कैसे मदद करूँ?",
  mr: "छान. मी सेतू आहे. मी तुम्हाला कशी मदत करू?",
  ta: "சரி. நான் சேது. நான் உங்களுக்கு எப்படி உதவட்டும்?",
  kn: "ಸರಿ. ನಾನು ಸೇತು. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
  bn: "ঠিক আছে. আমি সেতু. আমি কীভাবে সাহায্য করতে পারি?",
  gu: "સારું. હું સેતુ છું. હું તમારી કેવી રીતે મદદ કરું?",
  ml: "ശരി. ഞാൻ സേതു. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കാം?",
  pa: "ਠੀਕ ਹੈ. ਮੈਂ ਸੇਤੂ ਹਾਂ. ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰਾਂ?",
  or: "ଠିକ୍ ଅଛି. ମୁଁ ସେତୁ. ମୁଁ ଆପଣଙ୍କୁ କିପରି ସାହାଯ୍ୟ କରିପାରିବି?",
};

export function introForLanguage(language: PhraseLanguage): string {
  return SETU_INTRO_BY_LANG[language] ?? SETU_INTRO_BY_LANG.en;
}
