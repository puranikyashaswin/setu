# Native push-to-talk acceptance run

This is the first physical-device gate for the LiveKit voice slice. It tests
the existing voice surface only; camera, history, VAD, and animation work are
out of scope.

## Preconditions

- Staging API, LiveKit/SFU, TURN, and the voice worker are deployed.
- `SETU_ENV=staging`, `SETU_ROOM_NAMESPACE=setu-staging`, and
  `SARVAM_STT_TRANSPORT=direct_ws` are set on the server only.
- The iPhone and Android build point at the staging API and have microphone
  permission enabled.
- Capture worker logs and the mobile `[voice.turn]` lines. Do not capture raw
  audio, transcript content, or provider credentials in the test artifact.

## One-turn checks

For each device, repeat this sequence for 10 turns, then repeat it for a 50+
turn endurance run:

1. Connect while on Wi-Fi; confirm `session.ready` and `room_connected`.
2. Tap **Start voice**, speak a short sentence, and release to end push-to-talk.
3. Confirm at least one `transcript.partial` arrives before
   `transcript.final`.
4. Confirm assistant text deltas arrive in order and audio starts.
5. Speak during assistant playback. Confirm local playback stops immediately,
   a `turn.cancelled` event arrives, and no old audio resumes.
6. Start another turn and confirm the previous turn’s delayed chunks do not
   appear in it.

Record these elapsed markers per turn:

| Marker | Source | Meaning |
| --- | --- | --- |
| `mic_ready` | mobile/worker | microphone is enabled for the turn |
| `mic_audio_first_frame` | worker | normalized PCM reached the worker |
| `stt_partial` / `stt_final` | worker | first partial / final STT event |
| `llm_first_token` | worker | first 105B output delta |
| `tts_requested` | worker | TTS stream requested |
| `assistant_first_audio_published` | worker | first PCM frame entered LiveKit |
| `assistant_first_audio_played` | mobile | assistant audio track subscribed locally; use device observation for actual speaker playout |
| `barge_in` / `audio_stopped` | worker/mobile | cancellation requested / local queue cleared |

## Device matrix

Run the 10-turn sequence on a physical iPhone and Android device over Wi-Fi
and mobile data. Repeat with a wired headset or AirPods/Bluetooth headset,
lock/unlock, background/foreground, an incoming call, denied then re-enabled
microphone permission, a temporary network drop, and Android audio-focus loss.

The release gate is not met until all 50-turn runs complete without an audio
state break, and every interruption returns to a usable push-to-talk state.
