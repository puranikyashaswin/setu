import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SetuOrb } from "../components/design-system/SetuOrb";
import { VoiceSessionController } from "../features/voice/VoiceSessionController";
import { initialVoiceSnapshot } from "../features/voice/voiceMachine";
import type { VoiceSnapshot } from "../features/voice/protocol";
import { getOrCreateGuestUserId } from "../services/identity";
import { getVoiceLanguage } from "../services/preferences";

export function VoiceScreen(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(initialVoiceSnapshot);
  const controller = useRef<VoiceSessionController | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [language, setLanguage] = useState("en");

  useEffect(() => {
    let mounted = true;
    void Promise.all([getOrCreateGuestUserId(), getVoiceLanguage()]).then(([identity, selectedLanguage]) => {
      if (mounted) {
        setUserId(identity);
        setLanguage(selectedLanguage);
      }
    });
    return () => {
      mounted = false;
      void controller.current?.close();
    };
  }, []);
  const status = useMemo(() => {
    const labels: Record<VoiceSnapshot["state"], string> = {
      IDLE: "Tap to talk",
      CONNECTING: "Connecting",
      READY: "Ready",
      LISTENING: "Listening",
      USER_SPEAKING: "Hearing you",
      ENDPOINTING: "One moment",
      THINKING: "Thinking",
      SPEAKING: "Setu is speaking",
      INTERRUPTED: "Listening again",
      RECONNECTING: "Reconnecting",
      ERROR: "Something went wrong",
    };
    return labels[snapshot.state];
  }, [snapshot.state]);

  const handleOrbPress = async () => {
    if (!userId || snapshot.state === "CONNECTING" || snapshot.state === "ENDPOINTING" || snapshot.state === "THINKING" || snapshot.state === "RECONNECTING") return;
    if (snapshot.state === "IDLE" || snapshot.state === "ERROR") {
      const next = new VoiceSessionController(userId, language);
      controller.current = next;
      const unsubscribe = next.subscribe(setSnapshot);
      try {
        await next.connect();
        await next.beginTurn(makeTurnId());
      } catch {
        unsubscribe();
      }
      return;
    }
    if (snapshot.state === "USER_SPEAKING" || snapshot.state === "LISTENING") {
      await controller.current?.endTurn();
      return;
    }
    if (snapshot.state === "SPEAKING") controller.current?.bargeIn("user_tapped");
  };

  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>SETU</Text>
      <Text style={styles.heading}>Your bridge to what matters.</Text>
      <View style={styles.orbWrap}><SetuOrb state={snapshot.state} onPress={handleOrbPress} /></View>
      <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
      <Pressable style={styles.action} onPress={() => void handleOrbPress()} disabled={!userId}>
        <Text style={styles.actionText}>{snapshot.state === "USER_SPEAKING" ? "Finish speaking" : "Start voice"}</Text>
      </Pressable>
      {snapshot.transcript ? <Text style={styles.transcript}>{snapshot.transcript}</Text> : null}
      {snapshot.assistantText ? <Text style={styles.assistant}>{snapshot.assistantText}</Text> : null}
      {snapshot.lastError ? <Text style={styles.error}>{snapshot.lastError.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#FAF8F5", padding: 24 },
  eyebrow: { color: "#C2410C", fontSize: 11, fontWeight: "800", letterSpacing: 3, marginBottom: 10 },
  heading: { color: "#172033", fontSize: 28, lineHeight: 34, textAlign: "center", maxWidth: 300 },
  orbWrap: { marginVertical: 64 },
  status: { color: "#475569", fontSize: 16, fontWeight: "600" },
  error: { color: "#B91C1C", fontSize: 13, marginTop: 12, textAlign: "center" },
  action: { marginTop: 24, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 24, backgroundColor: "#172033" },
  actionText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  transcript: { color: "#475569", fontSize: 15, marginTop: 28, textAlign: "center", maxWidth: 320 },
  assistant: { color: "#172033", fontSize: 17, lineHeight: 24, marginTop: 12, textAlign: "center", maxWidth: 320 },
});

function makeTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
