import { AudioSession } from "@livekit/react-native";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrackPublication,
} from "livekit-client";

export const CONTROL_TOPIC = "setu-control-v1";

export type LiveKitRealtimeOptions = {
  sessionId: string;
  serverUrl: string;
  token: string;
  onControlEvent: (event: unknown) => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onDisconnected: (reason?: string) => void;
  onTelemetry?: (name: string) => void;
};

/** LiveKit is the SFU/media plane; JSON is only the reliable control channel. */
export class LiveKitRealtimeTransport {
  private room: Room | null = null;
  private remoteAudio = new Set<RemoteTrackPublication>();

  async connect(options: LiveKitRealtimeOptions): Promise<void> {
    if (!options.serverUrl) throw new Error("LiveKit server URL is missing");
    await AudioSession.startAudioSession();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;

    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== CONTROL_TOPIC) return;
      try {
        const json = new TextDecoder().decode(payload);
        options.onControlEvent(JSON.parse(json));
      } catch {
        // Malformed control packets must not affect the media session.
      }
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.remoteAudio.add(publication);
      options.onTelemetry?.("assistant_first_audio_played");
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.remoteAudio.delete(publication);
    });
    room.on(RoomEvent.Reconnecting, options.onReconnecting);
    room.on(RoomEvent.Reconnected, options.onReconnected);
    room.on(RoomEvent.Disconnected, (reason) => options.onDisconnected(String(reason ?? "unknown")));

    await room.connect(options.serverUrl, options.token, { autoSubscribe: true });
    options.onTelemetry?.("room_connected");
    // Push-to-talk: publish no microphone audio until the user starts a turn.
    await room.localParticipant.setMicrophoneEnabled(false);
  }

  async startPushToTalk(): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(true);
  }

  async endPushToTalk(): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(false);
  }

  async stopRemoteAudio(): Promise<void> {
    for (const publication of this.remoteAudio) {
      await publication.setSubscribed(false);
    }
  }

  async resumeRemoteAudio(): Promise<void> {
    for (const publication of this.remoteAudio) {
      await publication.setSubscribed(true);
    }
  }

  sendControl(payload: unknown): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    const data = new TextEncoder().encode(JSON.stringify(payload));
    void room.localParticipant.publishData(data, { reliable: true, topic: CONTROL_TOPIC });
  }

  async close(): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(false);
    await this.room?.disconnect();
    await AudioSession.stopAudioSession();
    this.remoteAudio.clear();
    this.room = null;
  }
}
