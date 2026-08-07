import React from "react";
import { Text } from "react-native";
import { Screen } from "../components/design-system/Screen";

export function DocumentCameraScreen(): React.JSX.Element {
  return <Screen title="Scan a document"><Text>Camera capture will upload directly to the document service.</Text></Screen>;
}
