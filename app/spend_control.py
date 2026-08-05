"""Instance-wide emergency stop for outbound provider spend.

Per-user reservations are the normal ceiling. This switch is the independent operator escape
hatch for an incident: once ``RC_PROVIDER_SPEND_DISABLED`` is enabled, provider dispatches stop
even if a route or future workflow forgot a higher-level admission check.
"""
from __future__ import annotations

import os

_EXPLICIT_FALSE = {"", "0", "false", "no", "off"}
MESSAGE = "AI provider features are temporarily paused. Try again later."


class ProviderSpendDisabled(RuntimeError):
    """A safe, user-displayable refusal raised before any provider request."""


def disabled() -> bool:
    """Whether the emergency stop is active.

    Any non-empty value except an explicit false spelling activates the stop. This is deliberate:
    a typo such as ``RC_PROVIDER_SPEND_DISABLED=treu`` must fail toward no spend, not silently
    restore it during an incident. The variable is read for every dispatch so tests and a local
    operator can toggle it without rebuilding process state.
    """
    raw = os.environ.get("RC_PROVIDER_SPEND_DISABLED", "").strip().lower()
    return raw not in _EXPLICIT_FALSE


def require_enabled() -> None:
    """Refuse before provider dispatch when the emergency stop is active."""
    if disabled():
        raise ProviderSpendDisabled(MESSAGE)
