"""Per invocation budgets; completed matches count, partial matches remain resumable."""
from __future__ import annotations

import time


class GameBudget:
    def __init__(self, limit=None):
        if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit < 1):
            raise ValueError("--games must be a positive integer")
        self.limit = limit
        self.used = 0

    @property
    def remaining(self):
        return None if self.limit is None else self.limit - self.used

    @property
    def exhausted(self):
        return self.remaining == 0

    def complete(self):
        if self.exhausted:
            raise ValueError("Completed match exceeds the session budget")
        self.used += 1


def deadline_for(minutes):
    return float("inf") if minutes is None else time.monotonic() + minutes * 60


def validation_rejection(state, split, seeds):
    """Exact arithmetic, only a necessary point-win gate; no sequential CI tests."""
    if split != "validation":
        return None
    games = len(state["groups"]) * 4 + len(state["current"])
    total = seeds * 4
    wins = int(sum(sum(group) for group in state["groups"]) + sum(state["current"]))
    remaining = total - games
    if games < total and 2 * (wins + remaining) <= total:
        return {"reason": "validation-no-possible-advantage", "gamesPlayed": games, "wins": wins,
                "remainingGames": remaining, "maxPossibleWinRate": (wins + remaining) / total,
                "requiredWinRateAbove": .5}
    return None
