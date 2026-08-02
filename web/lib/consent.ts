/** First-run voice-friendly permission framing (no modal required). */

export const MIC_CAMERA_CONSENT_PHRASE =
  "I need the microphone to hear you, and the camera only when you show a document.";

export function consentPhraseForLanguage(language: string): string {
  const lang = (language || "en").toLowerCase().slice(0, 2);
  if (lang === "hi") {
    return "मुझे आपको सुनने के लिए माइक्रोफ़ोन चाहिए, और कैमरा तभी जब आप कोई दस्तावेज़ दिखाएँ।";
  }
  if (lang === "te") {
    return "మిమ్మల్ని వినడానికి మైక్ కావాలి; మీరు డాక్యుమెంట్ చూపినప్పుడు మాత్రమే కెమెరా.";
  }
  return MIC_CAMERA_CONSENT_PHRASE;
}
