import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";

import type { VoiceState } from "../../features/voice/protocol";

export function SetuOrb({ state, onPress }: { state: VoiceState; onPress: () => void }): React.JSX.Element {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: state === "SPEAKING" ? 1.12 : 1.05, duration: 520, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 520, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, state]);

  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Start or stop Setu" onPress={onPress}>
      <Animated.View style={[styles.orb, { transform: [{ scale: pulse }] }]}>
        <View style={styles.highlight} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  orb: {
    width: 176,
    height: 176,
    borderRadius: 88,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FF6B00",
    shadowColor: "#FF6B00",
    shadowOpacity: 0.3,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  highlight: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: "#FFF7ED",
    opacity: 0.82,
  },
});
