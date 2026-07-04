"""LLM token/cost usage read routes: a project's own ledger and the app-global unattributed
ledger (spend with no project to bill, e.g. narration requested without an initiating project).
Named `usage_routes`-style module; drives the `app.usage` service."""
from __future__ import annotations

from fastapi import APIRouter

from .. import usage
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


@project_router.get("/usage")
def get_usage(pid: str):
    """This project's accumulated LLM token/cost usage (lifetime aggregate + per-model /
    per-operation breakdowns, cost in USD + exact nano-USD). `estimated` is true when some
    billed streams dropped before their final usage chunk. Cheap read of .state/usage.json."""
    return usage.summary()


@router.get("/api/usage/unattributed")
def get_unattributed_usage():
    """App-global ledger of LLM spend with no project to attribute to (e.g. narration requested
    without an initiating project). Kept explicit so nothing is silently dropped."""
    return usage.unattributed_summary()
