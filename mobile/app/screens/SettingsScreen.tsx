import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Screen } from "../components/design-system/Screen";
import { getVoiceLanguage, setVoiceLanguage } from "../services/preferences";

export function SettingsScreen(): React.JSX.Element {
  const [language, setLanguage] = useState("en");
  useEffect(() => { void getVoiceLanguage().then(setLanguage); }, []);

  const choose = (value: string) => {
    setLanguage(value);
    void setVoiceLanguage(value);
  };

  return (
    <Screen title="Settings">
      <Text>Voice language</Text>
      <View style={styles.row}>
        {[["en", "English"], ["hi", "Hindi"], ["te", "Telugu"]].map(([value, label]) => (
          <Pressable key={value} style={[styles.choice, language === value && styles.selected]} onPress={() => choose(value)}>
            <Text style={styles.choiceText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.note}>The selected input language is carried into the next realtime session. Output voice preferences remain server-controlled during this slice.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, marginTop: 16 },
  choice: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18, backgroundColor: "#E7E5E4" },
  selected: { backgroundColor: "#FDBA74" },
  choiceText: { color: "#172033", fontWeight: "700" },
  note: { color: "#64748B", marginTop: 20, lineHeight: 20 },
});
