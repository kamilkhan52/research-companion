"""Structured-ish stdlib logging for the backend (improvements §3.3).

Uvicorn already logs HTTP requests; this module adds the **background-thread story** — job
lifecycles, LLM call boundaries/retries, and git commits — which is where everything
interesting (and paid) happens and which request logs never see. Before this there was zero
logging in `app/`, so a failed graph build or a retried 502 left no trace beyond a truncated
error string on a job object.

Every line carries the active project id via a contextvar filter, so a line emitted from a job
worker is attributable to its project without threading the id through every call (the job
registry rebinds `config._active_project` inside the worker — see jobs.py — and this filter
reads it at emit time on the same thread).

Loggers are namespaced under `rc.*` (`rc.jobs`, `rc.llm`, `rc.committer`, …). Level comes from
`RC_LOG_LEVEL` (default INFO). `configure()` is idempotent and installs a single handler on the
`rc` root, so importing it from several entry points (or calling it twice) is safe.
"""
from __future__ import annotations

import logging
import os
import sys

from . import config

_ROOT = "rc"


class _ProjectFilter(logging.Filter):
    """Stamp the active project id (or '-') onto every record so the formatter can show it. A
    caller that knows the authoritative project can pass `extra={"project": ...}` (e.g. a job's
    resolved pid, which may differ from the emitting thread's ambient context); that explicit
    value is preserved rather than overwritten with the ambient one."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "project"):
            try:
                record.project = config.active_project_id() or "-"
            except Exception:
                record.project = "-"
        return True


class _CurrentStderrHandler(logging.StreamHandler):
    """A stderr handler that resolves `sys.stderr` at emit time rather than at construction.

    `logging.StreamHandler(sys.stderr)` captures the stream OBJECT. `configure()` runs at
    `app.main` import, and under pytest that import happens inside whichever test touches it
    first — while capture is active — so the handler bound itself to that test's temporary
    capture stream and every later line went somewhere already torn down. The symptom was a
    test asserting on captured stderr failing only when the alphabetically-first importer of
    `app.main` changed, which is about as hostile a failure as a suite can produce.

    In production `sys.stderr` never changes, so this costs an attribute lookup per line.
    """

    def __init__(self) -> None:
        super().__init__()

    @property
    def stream(self):
        return sys.stderr

    @stream.setter
    def stream(self, _value) -> None:
        pass  # StreamHandler.__init__ assigns to this; the property above is the real answer


def configure() -> None:
    """Install one stderr handler on the `rc` logger. Idempotent."""
    root = logging.getLogger(_ROOT)
    if getattr(root, "_rc_configured", False):
        return
    level = os.environ.get("RC_LOG_LEVEL", "INFO").upper()
    handler = _CurrentStderrHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s [%(project)s] %(message)s", datefmt="%H:%M:%S"))
    handler.addFilter(_ProjectFilter())
    root.addHandler(handler)
    root.setLevel(level)
    root.propagate = False  # own handler only; don't double-log through the stdlib root
    root._rc_configured = True  # type: ignore[attr-defined]


def get(name: str) -> logging.Logger:
    """A namespaced logger, e.g. `get("jobs")` -> the `rc.jobs` logger."""
    return logging.getLogger(f"{_ROOT}.{name}")
