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
  "Hi, welcome to Setu. I need the microphone to hear you, and the camera only when you show a document. Which language do you prefer?";

/**
 * After the user picks a language — short onboarding intro in that language.
 * Keep under ~25 words; server sarvam.intro_for_language is source of truth for TTS.
 */
export const SETU_INTRO_BY_LANG: Record<PhraseLanguage, string> = {
  en: "Hi. I am Setu. Ask me anything, or show me a document and I will explain it.",
  te: "నమస్కారం. నేను సేతు. ఏదైనా అడగండి, లేదా పత్రం చూపిస్తే వివరిస్తాను.",
  hi: "नमस्ते. मैं सेतु हूँ. कुछ भी पूछें, या दस्तावेज़ दिखाएँ — मैं समझाऊँगा.",
  mr: "नमस्कार. मी सेतू. काहीही विचारा, किंवा कागद दाखवा — मी समजावीन.",
  ta: "வணக்கம். நான் சேது. எதையும் கேளுங்கள், அல்லது ஆவணம் காட்டுங்கள்.",
  kn: "ನಮಸ್ಕಾರ. ನಾನು ಸೇತು. ಏನಾದರೂ ಕೇಳಿ, ಅಥವಾ ದಾಖಲೆ ತೋರಿಸಿ.",
  bn: "নমস্কার. আমি সেতু. যেকোনো প্রশ্ন করুন, বা নথি দেখান.",
  gu: "નમસ્તે. હું સેતુ. કંઈ પણ પૂછો, અથવા દસ્તાવેજ બતાવો.",
  ml: "നമസ്കാരം. ഞാൻ സേതു. എന്തും ചോദിക്കൂ, അല്ലെങ്കിൽ രേഖ കാണിക്കൂ.",
  pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ. ਮੈਂ ਸੇਤੂ ਹਾਂ. ਕੁਝ ਵੀ ਪੁੱਛੋ, ਜਾਂ ਦਸਤਾਵੇਜ਼ ਵਿਖਾਓ.",
  or: "ନମସ୍କାର. ମୁଁ ସେତୁ. କିଛି ପଚାରନ୍ତୁ, କିମ୍ବା ଦଲିଲ ଦେଖାନ୍ତୁ.",
};

export function introForLanguage(language: PhraseLanguage): string {
  return SETU_INTRO_BY_LANG[language] ?? SETU_INTRO_BY_LANG.en;
}
