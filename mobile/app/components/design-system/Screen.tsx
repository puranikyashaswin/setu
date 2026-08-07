import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export function Screen({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FAF8F5" },
  container: { flex: 1, paddingHorizontal: 24, paddingTop: 16 },
  title: { color: "#172033", fontSize: 30, fontWeight: "700", marginBottom: 20 },
});
