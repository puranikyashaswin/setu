"""Privacy-safe per-turn timing markers for device acceptance testing."""

from __future__ import annotations

from dataclasses import dataclass, field
from time import perf_counter_ns
from typing import Any


@dataclass
class TurnTrace:
    """Record elapsed milliseconds without retaining user or provider content."""

    turn_id: str
    _started_ns: int = field(default_factory=perf_counter_ns, repr=False)
    _marks: dict[str, int] = field(default_factory=dict, repr=False)

    def mark(self, name: str) -> None:
        elapsed_ms = (perf_counter_ns() - self._started_ns) / 1_000_000
        self._marks.setdefault(name, round(elapsed_ms, 2))

    def snapshot(self) -> dict[str, Any]:
        return {"turn_id": self.turn_id, **self._marks}
