import AsyncStorage from "@react-native-async-storage/async-storage";

const USER_ID_KEY = "setu.guest.user_id.v1";

/** Compatibility identity for the migration period; replace with auth later. */
export async function getOrCreateGuestUserId(): Promise<string> {
  const existing = await AsyncStorage.getItem(USER_ID_KEY);
  if (existing) return existing;
  const value = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await AsyncStorage.setItem(USER_ID_KEY, value);
  return value;
}
