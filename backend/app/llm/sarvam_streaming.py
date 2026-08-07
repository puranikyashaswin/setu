"""Sarvam streaming provider adapters used by the native voice worker.

All imports happen lazily so protocol/FSM tests never need provider credentials
or a network connection.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import urllib.parse
from collections.abc import AsyncIterable, AsyncIterator
from contextlib import suppress

from backend.app.llm.policy import ModelPolicy
from backend.app.voice.pipeline import TranscriptUpdate


def _language_code(language: str) -> str:
    raw = (language or "en").lower().split("-", 1)[0]
    return "or-IN" if raw in {"or", "od"} else f"{raw}-IN"


class SarvamRealtimeStt:
    """Saaras realtime STT over the server-side Sarvam WebSocket."""

    async def transcribe(self, audio: AsyncIterable[bytes], *, language: str) -> AsyncIterator[TranscriptUpdate]:
        from sarvamai import AsyncSarvamAI

        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            raise RuntimeError("SARVAM_API_KEY is required")
        client = AsyncSarvamAI(api_subscription_key=key)
        if (os.getenv("SARVAM_STT_TRANSPORT") or "sdk").strip().lower() == "direct_ws":
            async for update in self._transcribe_direct_websocket(audio, language=language, api_key=key):
                yield update
            return
        realtime = getattr(client, "speech_to_text_realtime_streaming", None)
        if realtime is None:
            # sarvamai 0.1.x exposes the production Saaras v3 websocket under
            # speech_to_text_streaming. Newer SDKs may expose the realtime
            # convenience API; support both during the migration period.
            async for update in self._transcribe_streaming_v3(client, audio, language):
                yield update
            return

        from sarvamai import RealtimeAudioInput, RealtimeEnd

        async with client.speech_to_text_realtime_streaming.connect(
            language_code=_language_code(language),
            stream_type="fast",
            endpointing="vad",
            encoding="linear16",
            sample_rate=16000,
        ) as ws:
            sender = asyncio.create_task(self._send_audio(ws, audio, RealtimeAudioInput, RealtimeEnd))
            try:
                async for message in ws:
                    event = getattr(message, "event", "")
                    if event == "transcript.partial":
                        yield TranscriptUpdate(text=str(getattr(message, "text", "")), final=False)
                    elif event == "transcript.final":
                        yield TranscriptUpdate(text=str(getattr(message, "text", "")), final=True)
                        break
                    elif event == "error" and getattr(message, "is_fatal", True):
                        raise RuntimeError(str(getattr(message, "message", "stt_error")))
            finally:
                sender.cancel()

    async def _transcribe_streaming_v3(self, client, audio: AsyncIterable[bytes], language: str) -> AsyncIterator[TranscriptUpdate]:
        async with client.speech_to_text_streaming.connect(
            model="saaras:v3",
            mode="transcribe",
            language_code=_language_code(language),
            sample_rate="16000",
            high_vad_sensitivity=True,
            vad_signals=True,
            flush_signal=True,
            input_audio_codec="pcm_s16le",
        ) as ws:
            sender = asyncio.create_task(self._send_legacy_audio(ws, audio))
            try:
                async for message in ws:
                    if getattr(message, "type", "") == "data":
                        text = str(getattr(getattr(message, "data", None), "transcript", ""))
                        if text:
                            yield TranscriptUpdate(text=text, final=True)
                            break
                    elif getattr(message, "type", "") == "error":
                        raise RuntimeError(str(getattr(getattr(message, "data", None), "message", "stt_error")))
            finally:
                sender.cancel()
                with suppress(asyncio.CancelledError):
                    await sender

    async def _transcribe_direct_websocket(
        self,
        audio: AsyncIterable[bytes],
        *,
        language: str,
        api_key: str,
    ) -> AsyncIterator[TranscriptUpdate]:
        """Use Sarvam's documented WebSocket directly, bypassing SDK lag."""

        try:
            from websockets.asyncio.client import connect
        except ImportError:  # pragma: no cover - compatibility with websockets <17
            from websockets import connect

        base_url = (os.getenv("SARVAM_STT_WS_URL") or "wss://api.sarvam.ai/speech-to-text/ws").strip()
        query = urllib.parse.urlencode(
            {
                "language-code": _language_code(language),
                "model": os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                "mode": os.getenv("SARVAM_STT_MODE", "transcribe"),
                "sample_rate": "16000",
                "vad_signals": "true",
                "flush_signal": "true",
                "input_audio_codec": "pcm_s16le",
            }
        )
        url = f"{base_url}{'&' if '?' in base_url else '?'}{query}"
        async with connect(url, additional_headers={"Api-Subscription-Key": api_key}) as ws:
            sender = asyncio.create_task(self._send_direct_audio(ws, audio))
            try:
                async for raw in ws:
                    message = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
                    update = self._parse_transcript_message(message)
                    if update is None:
                        continue
                    yield update
                    if update.final:
                        break
            finally:
                sender.cancel()
                with suppress(asyncio.CancelledError):
                    await sender

    @staticmethod
    async def _send_direct_audio(ws, audio: AsyncIterable[bytes]) -> None:
        async for chunk in audio:
            await ws.send(
                json.dumps(
                    {
                        "audio": {
                            "data": base64.b64encode(chunk).decode("ascii"),
                            "sample_rate": 16_000,
                            "encoding": "pcm_s16le",
                        }
                    }
                )
            )
        await ws.send(json.dumps({"type": "flush"}))

    @staticmethod
    def _parse_transcript_message(message: object) -> TranscriptUpdate | None:
        if not isinstance(message, dict):
            return None
        event = str(message.get("event") or message.get("type") or message.get("event_type") or "").lower()
        payload = message.get("data") if isinstance(message.get("data"), dict) else message
        if event == "error":
            detail = payload.get("message") if isinstance(payload, dict) else "stt_error"
            raise RuntimeError(str(detail or "stt_error"))
        if not isinstance(payload, dict):
            return None
        text = payload.get("text") or payload.get("transcript")
        if not isinstance(text, str) or not text:
            return None
        explicit_final = payload.get("is_final")
        if explicit_final is None:
            explicit_final = payload.get("final")
        if isinstance(explicit_final, bool):
            final = explicit_final
        else:
            final = event in {"transcript.final", "final", "data"}
        if event in {"transcript.partial", "partial", "interim", "transcript.interim"}:
            final = False
        return TranscriptUpdate(text=text, final=final)

    @staticmethod
    async def _send_legacy_audio(ws, audio: AsyncIterable[bytes]) -> None:
        async for chunk in audio:
            await ws.transcribe(
                audio=base64.b64encode(chunk).decode("ascii"),
                encoding="pcm_s16le",
                sample_rate=16000,
            )
        await ws.flush()

    @staticmethod
    async def _send_audio(ws, audio, input_type, end_type) -> None:
        async for chunk in audio:
            await ws.send_realtime_audio_input(input_type(audio=base64.b64encode(chunk).decode("ascii")))
        await ws.send_realtime_end(end_type())


class SarvamStreamingLlm:
    async def stream(self, messages: list[dict[str, str]], *, language: str, policy: ModelPolicy) -> AsyncIterator[str]:
        from sarvamai import SarvamAI

        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            raise RuntimeError("SARVAM_API_KEY is required")
        client = SarvamAI(api_subscription_key=key)
        response = await asyncio.to_thread(
            client.chat.completions,
            model="sarvam-105b",
            messages=messages,
            stream=True,
            reasoning_effort=None if policy.reasoning_effort == "none" else policy.reasoning_effort,
            max_tokens=policy.max_output_tokens,
        )
        for chunk in response:
            if not getattr(chunk, "choices", None):
                continue
            delta = getattr(chunk.choices[0], "delta", None)
            content = getattr(delta, "content", None) if delta else None
            if content:
                yield str(content)


class SarvamStreamingTts:
    async def stream(self, text: str, *, language: str) -> AsyncIterator[bytes]:
        from sarvamai import AsyncSarvamAI, AudioOutput, EventResponse

        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            raise RuntimeError("SARVAM_API_KEY is required")
        client = AsyncSarvamAI(api_subscription_key=key)
        async with client.text_to_speech_streaming.connect(model="bulbul:v3", send_completion_event=True) as ws:
            await ws.configure(
                language_code=_language_code(language),
                speaker="shubh",
                output_audio_codec="linear16",
                speech_sample_rate=22050,
            )
            await ws.convert(text)
            await ws.flush()
            async for message in ws:
                if isinstance(message, AudioOutput):
                    yield base64.b64decode(message.data.audio)
                elif isinstance(message, EventResponse) and getattr(message.data, "event_type", "") == "final":
                    break
