"""Deterministic paper identity and cross-project location lookup (R10.18).

Projects remain independent git-backed records. This module only discovers that two records
refer to the same scholarly work; reusing one still goes through ``project_split``'s explicit
copy/move path, which materializes an independent destination copy of the paper and its work.

Identity precedence is deliberately conservative:

1. versionless arXiv id;
2. normalized DOI (including doi.org URLs);
3. normalized source URL without query/fragment;
4. exact normalized title, but only when at least one side lacks a strong identifier.

The final rule prevents two distinct papers with the same title *and* different known ids from
being collapsed. Everything here is local string/file inspection: no network, LLM, or writes.
"""
from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import unquote, urlsplit, urlunsplit

from . import config, projects, sessions, store

_DOI_RE = re.compile(r"(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)", re.I)
_ARXIV_ID_RE = re.compile(
    r"(?P<id>(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?)",
    re.I,
)
_ARXIV_URL_RE = re.compile(
    r"arxiv\.org/(?:abs|pdf)/"
    r"(?P<id>(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?)",
    re.I,
)
_TITLE_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
# A single-process app-global gate closes the check→add race between two concurrent requests
# targeting different project write locks. Move/copy writes the destination before removing
# the source, so at least one location stays visible throughout its own transaction.
_ADD_LOCK = threading.RLock()


@contextmanager
def add_guard() -> Iterator[None]:
    """Serialize the cross-project duplicate check plus metadata add."""
    with _ADD_LOCK:
        yield


def normalize_arxiv_id(value: str | None) -> str | None:
    """Return a versionless, lowercase arXiv id from an id or arXiv URL."""
    raw = unquote((value or "").strip())
    if not raw:
        return None
    match = _ARXIV_URL_RE.search(raw)
    if not match:
        match = _ARXIV_ID_RE.fullmatch(re.sub(r"^arxiv:\s*", "", raw, flags=re.I))
    if not match:
        return None
    return re.sub(r"v\d+$", "", match.group("id"), flags=re.I).lower()


def normalize_doi(value: str | None) -> str | None:
    """Return a lowercase DOI without URL/prefix or trailing citation punctuation."""
    raw = unquote((value or "").strip())
    match = _DOI_RE.search(raw)
    if not match:
        return None
    return match.group(1).split("?", 1)[0].split("#", 1)[0].rstrip(".,;:)]}").lower()


def normalize_source_url(value: str | None) -> str | None:
    """Normalize a source URL for identity matching, ignoring query/fragment cache-busters."""
    raw = (value or "").strip()
    if not raw or not re.match(r"^https?://", raw, re.I):
        return None
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        return None
    if not host:
        return None
    default_port = (parsed.scheme.lower() == "https" and port == 443) or (
        parsed.scheme.lower() == "http" and port == 80
    )
    netloc = host if port is None or default_port else f"{host}:{port}"
    path = re.sub(r"/+", "/", unquote(parsed.path or "/"))
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, "", ""))


def normalize_title(value: str | None) -> str | None:
    """Exact-title fallback normalized for case, punctuation, and Unicode presentation."""
    raw = unicodedata.normalize("NFKC", (value or "")).casefold()
    normalized = " ".join(part for part in _TITLE_WORD_RE.split(raw) if part)
    return normalized or None


def identity_keys(
    *,
    title: str | None,
    arxiv_id: str | None = None,
    source_url: str | None = None,
) -> tuple[set[str], str | None]:
    """Return (strong keys, normalized title). Keys are namespaced and safe to expose."""
    strong: set[str] = set()
    arxiv = normalize_arxiv_id(arxiv_id) or normalize_arxiv_id(source_url)
    if arxiv:
        strong.add(f"arxiv:{arxiv}")
    doi = normalize_doi(source_url)
    if doi:
        strong.add(f"doi:{doi}")
    source = normalize_source_url(source_url)
    if source and not arxiv and not doi:
        strong.add(f"url:{source}")
    return strong, normalize_title(title)


def _shared_identity(
    candidate_strong: set[str],
    candidate_title: str | None,
    paper_strong: set[str],
    paper_title: str | None,
) -> str | None:
    shared = sorted(candidate_strong & paper_strong)
    if shared:
        return shared[0]
    if (
        candidate_title
        and candidate_title == paper_title
        and (not candidate_strong or not paper_strong)
    ):
        return f"title:{candidate_title}"
    return None


def find_locations(
    *,
    title: str,
    arxiv_id: str | None = None,
    source_url: str | None = None,
    exclude_pid: str | None = None,
    only_pids: set[str] | None = None,
) -> list[dict]:
    """Find current reading-list locations for a candidate across the projects in `only_pids`.

    `only_pids=None` means every project, which is right for callers with no user context (the
    adoption script, maintenance). **Route callers must pass a scope**: this reads reading lists and
    returns paper titles and project names, so an unscoped call from a request hands one user a
    search across everyone else's library.

    The caller's active-project context is restored after every project read. Registry-derived
    ids alone cross the path boundary, and the result is a detached plain dict.
    """
    candidate_strong, candidate_title = identity_keys(
        title=title,
        arxiv_id=arxiv_id,
        source_url=source_url,
    )
    if not candidate_strong and not candidate_title:
        return []

    locations: list[dict] = []
    for project in projects.list_projects():
        pid = project["id"]
        if pid == exclude_pid:
            continue
        if only_pids is not None and pid not in only_pids:
            continue
        token = config.set_active_project(pid)
        try:
            state_by_slug = sessions.session_states()
            for paper in store.list_papers(state_by_slug):
                paper_arxiv = paper.arxiv_id or store.corpus_arxiv_id_for(paper.slug)
                paper_strong, paper_title = identity_keys(
                    title=paper.title,
                    arxiv_id=paper_arxiv,
                    source_url=paper.source_url,
                )
                shared = _shared_identity(
                    candidate_strong,
                    candidate_title,
                    paper_strong,
                    paper_title,
                )
                if not shared:
                    continue
                jsonl, branches = sessions.transcript_paths(paper.slug)
                session_meta = sessions.index_entry(paper.slug)
                locations.append({
                    **paper.to_dict(),
                    "project_id": pid,
                    "project_name": project["name"],
                    "identity": shared,
                    "has_discussion": bool(
                        session_meta is not None or jsonl.exists() or branches.exists()
                    ),
                })
        finally:
            config.reset_active_project(token)

    # Prefer the richest reusable record, then the newest project ordering from the registry.
    locations.sort(
        key=lambda item: (
            not item["has_notes"],
            not item["has_discussion"],
            not item["retrieved"],
            item["project_name"].casefold(),
            item["slug"],
        ),
    )
    return locations
