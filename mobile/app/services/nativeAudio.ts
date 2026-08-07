import { NativeEventEmitter, NativeModules } from "react-native";

export type AudioRouteEvent = {
  route: string;
  interrupted: boolean;
};

export type NativeAudioEngine = {
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  flushPlayback(): Promise<void>;
  addListener(listener: (event: AudioRouteEvent) => void): { remove(): void };
};

const NativeSetuAudio = NativeModules.SetuAudio as {
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  flushPlayback(): Promise<void>;
} | undefined;

const emitter = NativeModules.SetuAudio ? new NativeEventEmitter(NativeModules.SetuAudio) : null;

export const nativeAudio: NativeAudioEngine = {
  startSession: () => NativeSetuAudio?.startSession() ?? Promise.resolve(),
  stopSession: () => NativeSetuAudio?.stopSession() ?? Promise.resolve(),
  flushPlayback: () => NativeSetuAudio?.flushPlayback() ?? Promise.resolve(),
  addListener: (listener) => emitter?.addListener("SetuAudioRouteChanged", listener) ?? { remove() {} },
};
