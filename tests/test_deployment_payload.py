"""The production image must contain every file its runtime and runbook address.

This is deliberately a source-level packaging test: CI does not build Docker images, so a missing
COPY otherwise ships cleanly and is discovered only after a real database is connected.
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_migrations_and_adoption_script_are_in_the_runtime_image() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    assert "COPY supabase/migrations/ ./supabase/migrations/" in dockerfile
    assert "COPY scripts/adopt_projects.py ./scripts/adopt_projects.py" in dockerfile

    # Docker cannot COPY a file excluded from its build context. Keep the rest of scripts/ out of
    # the image context while making this single operational entry point available.
    assert "scripts/*" in dockerignore
    assert "!scripts/adopt_projects.py" in dockerignore
    assert "scripts/" not in dockerignore
