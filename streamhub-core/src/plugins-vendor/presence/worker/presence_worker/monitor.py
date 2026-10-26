"""
Presence state machine — pure logic (unit-tested, no I/O, injectable clock).

Per zone it tracks occupancy over time and emits the three presence events:

  presence.absent      the zone has been EMPTY continuously for longer than
                       the absence threshold (fired once per empty episode)
  presence.returned    a person showed up in a zone that had fired `absent`
  presence.after_hours a person is present while OUTSIDE the work schedule
                       (fired once per continuous occupied episode; re-arms
                       when the zone empties or the schedule resumes)

The absence timer of a zone that has NEVER seen a person is anchored at the
first update the monitor processes — an empty desk at worker start is absent
`threshold` later, which is the behavior a workstation monitor wants.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .zones import Zone


@dataclass
class ZoneState:
    persons: int = 0
    last_present: float | None = None
    empty_since: float | None = None
    absent_fired: bool = False
    after_hours_fired: bool = False


class PresenceMonitor:
    def __init__(
        self,
        zones: Iterable[Zone],
        threshold_s: float,
        in_schedule: Callable[[float], bool] | None = None,
        after_hours_enabled: bool = True,
    ) -> None:
        self.zones: list[Zone] = list(zones)
        self.threshold_s = max(0.0, float(threshold_s))
        self._in_schedule = in_schedule or (lambda _ts: True)
        self.after_hours_enabled = after_hours_enabled
        self._state: dict[str, ZoneState] = {z.id: ZoneState() for z in self.zones}
        self._started = False

    def state(self, zone_id: str) -> ZoneState:
        return self._state[zone_id]

    def update(self, ts: float, counts: Mapping[str, int]) -> list[dict[str, Any]]:
        """Process one occupancy sample; returns the events it triggered."""
        events: list[dict[str, Any]] = []
        in_hours = self._in_schedule(ts)
        for zone in self.zones:
            st = self._state[zone.id]
            n = int(counts.get(zone.id, 0))
            if not self._started and n == 0 and st.empty_since is None:
                st.empty_since = ts  # anchor the initial absence timer

            if n > 0:
                if st.absent_fired:
                    empty_ref = st.empty_since if st.empty_since is not None else ts
                    events.append(
                        {
                            "event": "presence.returned",
                            "zone": zone.id,
                            "zoneName": zone.name,
                            "ts": ts,
                            "persons": n,
                            "absentForSec": round(max(0.0, ts - empty_ref), 1),
                        }
                    )
                    st.absent_fired = False
                st.last_present = ts
                st.empty_since = None
                if self.after_hours_enabled and not in_hours:
                    if not st.after_hours_fired:
                        events.append(
                            {
                                "event": "presence.after_hours",
                                "zone": zone.id,
                                "zoneName": zone.name,
                                "ts": ts,
                                "persons": n,
                            }
                        )
                        st.after_hours_fired = True
                else:
                    # Back inside the schedule → re-arm for the evening.
                    st.after_hours_fired = False
            else:
                if st.empty_since is None:
                    st.empty_since = ts
                st.after_hours_fired = False
                if (
                    not st.absent_fired
                    and (ts - st.empty_since) >= self.threshold_s
                ):
                    events.append(
                        {
                            "event": "presence.absent",
                            "zone": zone.id,
                            "zoneName": zone.name,
                            "ts": ts,
                            "emptyForSec": round(ts - st.empty_since, 1),
                            "thresholdMin": round(self.threshold_s / 60.0, 2),
                        }
                    )
                    st.absent_fired = True
            st.persons = n
        self._started = True
        return events

    def snapshot(self, ts: float) -> list[dict[str, Any]]:
        """Per-zone live view for the core live-data channel."""
        out: list[dict[str, Any]] = []
        for zone in self.zones:
            st = self._state[zone.id]
            out.append(
                {
                    "id": zone.id,
                    "name": zone.name,
                    "persons": st.persons,
                    "absent": st.absent_fired,
                    "emptyForSec": (
                        round(max(0.0, ts - st.empty_since), 1)
                        if st.empty_since is not None
                        else 0.0
                    ),
                    "lastPresentTs": st.last_present,
                }
            )
        return out
