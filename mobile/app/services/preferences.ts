import AsyncStorage from "@react-native-async-storage/async-storage";

const VOICE_LANGUAGE_KEY = "setu.voice.language.v1";

export async function getVoiceLanguage(): Promise<string> {
  return (await AsyncStorage.getItem(VOICE_LANGUAGE_KEY)) || "en";
}

export async function setVoiceLanguage(language: string): Promise<void> {
  await AsyncStorage.setItem(VOICE_LANGUAGE_KEY, language);
}
