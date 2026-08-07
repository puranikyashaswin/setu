"""Versioned protocol shared by native clients and the realtime backend."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

ProtocolVersion = Literal["voice.v1"]
VoiceState = Literal[
    "IDLE",
    "CONNECTING",
    "READY",
    "LISTENING",
    "USER_SPEAKING",
    "ENDPOINTING",
    "THINKING",
    "SPEAKING",
    "INTERRUPTED",
    "RECONNECTING",
    "ERROR",
]


class ProtocolModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class VoiceEventBase(ProtocolModel):
    protocol: ProtocolVersion = "voice.v1"
    session_id: str = Field(alias="sessionId", min_length=1, max_length=128)
    turn_id: str = Field(alias="turnId", min_length=1, max_length=128)


class SessionReadyEvent(VoiceEventBase):
    type: Literal["session.ready"] = "session.ready"


class TranscriptPartialEvent(VoiceEventBase):
    type: Literal["transcript.partial"] = "transcript.partial"
    text: str = Field(max_length=12_000)


class TranscriptFinalEvent(VoiceEventBase):
    type: Literal["transcript.final"] = "transcript.final"
    text: str = Field(max_length=12_000)


class AssistantTextDeltaEvent(VoiceEventBase):
    type: Literal["assistant.text.delta"] = "assistant.text.delta"
    text: str = Field(max_length=12_000)


class AssistantAudioStartedEvent(VoiceEventBase):
    type: Literal["assistant.audio.started"] = "assistant.audio.started"


class AssistantAudioChunkEvent(VoiceEventBase):
    type: Literal["assistant.audio.chunk"] = "assistant.audio.chunk"
    sequence: int = Field(ge=0)
    heard_until_ms: int | None = Field(default=None, alias="heardUntilMs", ge=0)


class AssistantAudioFinishedEvent(VoiceEventBase):
    type: Literal["assistant.audio.finished"] = "assistant.audio.finished"


class BargeInEvent(VoiceEventBase):
    type: Literal["barge_in"] = "barge_in"
    reason: str = Field(default="speech_detected", max_length=120)


class TurnCancelledEvent(VoiceEventBase):
    type: Literal["turn.cancelled"] = "turn.cancelled"
    reason: str = Field(max_length=240)


class ErrorEvent(VoiceEventBase):
    type: Literal["error"] = "error"
    code: str = Field(max_length=80)
    message: str = Field(max_length=500)


VoiceEvent = Annotated[
    Union[
        SessionReadyEvent,
        TranscriptPartialEvent,
        TranscriptFinalEvent,
        AssistantTextDeltaEvent,
        AssistantAudioStartedEvent,
        AssistantAudioChunkEvent,
        AssistantAudioFinishedEvent,
        BargeInEvent,
        TurnCancelledEvent,
        ErrorEvent,
    ],
    Field(discriminator="type"),
]


class TurnMetric(BaseModel):
    """Server-side timestamps for one turn; never include user content."""

    model_config = ConfigDict(extra="forbid")

    mic_started_ms: int | None = None
    speech_started_ms: int | None = None
    speech_ended_ms: int | None = None
    stt_partial_ms: int | None = None
    stt_final_ms: int | None = None
    llm_first_token_ms: int | None = None
    tts_requested_ms: int | None = None
    first_audio_played_ms: int | None = None
    audio_finished_ms: int | None = None
    barge_in_ms: int | None = None


class RealtimeSessionRequest(ProtocolModel):
    language: str = Field(default="en", min_length=2, max_length=12)
    session_id: str | None = Field(default=None, alias="sessionId", max_length=128)


class RealtimeSessionResponse(ProtocolModel):
    protocol: ProtocolVersion = "voice.v1"
    session_id: str = Field(alias="sessionId")
    token: str
    expires_at: datetime = Field(alias="expiresAt")
    transport: Literal["livekit", "mock"] = "livekit"
    server_url: str | None = Field(default=None, alias="serverUrl")
    room_name: str | None = Field(default=None, alias="roomName")
    data_channel: str = Field(default="setu-control-v1", alias="dataChannel")
    ice_servers: list[dict] = Field(default_factory=list, alias="iceServers")
    capabilities: list[Literal["audio", "data", "barge_in"]] = Field(
        default_factory=lambda: ["audio", "data", "barge_in"]
    )
