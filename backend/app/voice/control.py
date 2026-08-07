"""Validated data-channel commands for the push-to-talk room."""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


class ControlMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    protocol: Literal["voice.v1"] = "voice.v1"
    session_id: str = Field(alias="sessionId", min_length=1, max_length=128)
    turn_id: str = Field(alias="turnId", min_length=1, max_length=128)


class TurnStart(ControlMessage):
    type: Literal["turn.start"] = "turn.start"


class TurnStop(ControlMessage):
    type: Literal["turn.stop"] = "turn.stop"


class TurnCancel(ControlMessage):
    type: Literal["turn.cancel"] = "turn.cancel"
    reason: str = Field(default="client_cancelled", max_length=120)


ControlEnvelope = Annotated[Union[TurnStart, TurnStop, TurnCancel], Field(discriminator="type")]


def parse_control_message(payload: bytes | str) -> ControlEnvelope:
    """Parse one data packet and reject unknown commands before side effects."""

    from pydantic import TypeAdapter

    value = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    return TypeAdapter(ControlEnvelope).validate_json(value)


def assert_session_scope(message: ControlEnvelope, session_id: str) -> None:
    if message.session_id != session_id:
        raise ValueError("control message is outside the active session")
