"""HTTP route modules, one per feature area, split out of the former monolithic main.py.

Each module owns its routes plus the request models and helpers they use. App-global routes
hang off a plain `router = APIRouter()`; per-project routes hang off `make_project_router()`,
which pre-binds the `/api/projects/{pid}` prefix and the `use_project` active-project dependency
so that scoping is defined in exactly one place. main.py assembles the app and includes them.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import projects


def make_project_router() -> APIRouter:
    """A router pre-scoped to /api/projects/{pid} with the active-project dependency bound.
    Every per-project feature module builds its routes on one of these, so the prefix and the
    `use_project` contextvar binding (invariant 2) are declared once rather than per module."""
    return APIRouter(prefix="/api/projects/{pid}",
                     dependencies=[Depends(projects.use_project)], tags=["project"])
