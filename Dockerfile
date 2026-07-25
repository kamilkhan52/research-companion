# Production image for the Research Reading Companion backend (M1).
#
# Layout mirrors the repo on purpose: config.BASE_DIR is the parent of app/, and WEB_DIR is
# derived as BASE_DIR/web/dist — so app/ and web/dist/ must sit side by side under /srv or the
# SPA mount silently falls back to a missing directory.
#
# Two non-obvious requirements:
#  * `git` must be installed. committer.py and projects.py shell out to `git` for every approved
#    note and every new project; without the binary the record layer fails at runtime, not at
#    build time. Commit identity is already pinned via config.git_identity_args(), so no global
#    git config is needed in the image.
#  * Mutable state must NOT live in the image. PROJECTS_ROOT and APP_STATE_DIR are pointed at the
#    mounted volume (/data) by fly.toml; the image itself stays read-only in practice.

FROM python:3.11-slim-bookworm

# git: required at runtime (see above). ca-certificates: outbound TLS to OpenRouter/OpenAI/arXiv.
# --no-install-recommends keeps the image small; the layer is cleaned in the same RUN so the apt
# lists never land in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# Dependencies first so a code-only change doesn't reinstall them. PyMuPDF and pypdf ship
# manylinux wheels, so no compiler toolchain is needed on this base.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Runtime payload only. Everything else the repo carries (tests, mobile/, scripts/, docs/) is
# excluded via .dockerignore — see that file for why projects/ and .app-state/ in particular must
# never be baked in.
COPY app/ ./app/
COPY web/dist/ ./web/dist/

# Non-root. The volume is chowned to this uid by the mount, and nothing in the image is written.
RUN useradd --create-home --uid 10001 rc && chown -R rc:rc /srv
USER rc

EXPOSE 8080

# ONE worker, deliberately (CLAUDE.md invariant 6): job registries, dedup, and file writes are
# in-process and assume a single process. Do not add --workers N here without first moving job
# state off the process. No --reload in production.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
