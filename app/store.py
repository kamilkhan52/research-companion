"""The persistent store: plain markdown in a git repo (Section 8).

Parses reading-list.md into a paper index, derives stable slugs, exposes the citation
graph used for context selection, and reads/writes corpus files and synthesis.md. This
module never calls an LLM and never makes network calls — it is pure spine.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

from . import config
from .fileio import atomic_write_text
from .models import Paper


# Per-project file locations resolve against the active project (config.project_dir()), so
# the same store functions serve every project. The aggregate cross-paper notes (the "working
# notes") live in working-notes.md; read_synthesis/write_synthesis are the historical names.
def _reading_list() -> Path:
    return config.project_dir() / "reading-list.md"


def _reading_method() -> Path:
    return config.project_dir() / "reading-method.md"


def _synthesis() -> Path:
    return config.project_dir() / "working-notes.md"


def _corpus_dir() -> Path:
    return config.project_dir() / "corpus"

# Entry line: **Title** — *unread*  (em dash, italic status). Tolerates a plain hyphen too.
_ENTRY_RE = re.compile(r"^\*\*(?P<title>.+?)\*\*\s*[—-]\s*\*(?P<status>unread|read)\*\s*$")
_H2_RE = re.compile(r"^##\s+(?P<group>.+?)\s*$")
_SLUG_COMMENT_RE = re.compile(r"<!--\s*slug:\s*(?P<slug>[a-z0-9-]+)\s*-->", re.I)
_CITES_COMMENT_RE = re.compile(r"<!--\s*cites:\s*(?P<cites>[a-z0-9,\s-]+?)\s*-->", re.I)

# Slugs for the three titles whose system name isn't the prefix before a colon.
_SLUG_SPECIALS = [
    ("pagedattention", "vllm-pagedattention"),
    ("sarathi-serve", "sarathi-serve"),
    ("flashattention-2 and flashdecoding", "flashattention-2-flashdecoding"),
]

# Best-effort citation links among list papers (which prior Notes to auto-load). The file
# may override per entry via `<!-- cites: a, b -->`; see the architecture's machine-readable
# citation field. These only influence context selection, so being approximate is safe.
CITATION_GRAPH: dict[str, list[str]] = {
    "distserve": ["vllm-pagedattention", "orca", "sarathi-serve"],
    "splitwise": ["vllm-pagedattention", "orca"],
    "mooncake": ["vllm-pagedattention", "orca", "distserve", "splitwise"],
    "memserve": ["distserve", "splitwise", "vllm-pagedattention"],
    "sarathi-serve": ["orca", "vllm-pagedattention"],
    "vllm-pagedattention": ["orca"],
    "orca": [],
    "flashattention-2-flashdecoding": [],
    "awq": [],
    "cxl-speckv": ["vllm-pagedattention", "distserve", "mooncake", "pond"],
    "banaserve": ["vllm-pagedattention", "distserve", "mooncake", "splitwise"],
    "pond": [],
    "decima": [],
    "park": ["decima"],
    "torta": ["vllm-pagedattention", "distserve", "decima", "park"],
    "flashinfer": ["vllm-pagedattention", "orca", "flashattention-2-flashdecoding", "punica"],
    "punica": ["vllm-pagedattention", "orca"],
    "helix": ["vllm-pagedattention", "orca", "distserve"],
}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def derive_slug(title: str) -> str:
    low = title.lower()
    for needle, slug in _SLUG_SPECIALS:
        if needle in low:
            return slug
    head = title.split(":")[0]
    slug = re.sub(r"[^a-z0-9]+", "-", head.lower()).strip("-")
    return slug or re.sub(r"[^a-z0-9]+", "-", low).strip("-")[:48]


def read_method() -> str:
    p = _reading_method()
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_method(content: str) -> None:
    atomic_write_text(_reading_method(), content.rstrip() + "\n")


def read_synthesis() -> str:
    p = _synthesis()
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_synthesis(content: str) -> None:
    atomic_write_text(_synthesis(), content.rstrip() + "\n")


def corpus_path(slug: str) -> Path:
    return _corpus_dir() / f"{slug}.md"


def _parse_entries() -> list[dict]:
    """Return entries with title, status, group, slug, cites, and the raw text block."""
    rl = _reading_list()
    text = rl.read_text(encoding="utf-8") if rl.exists() else ""
    lines = text.splitlines()
    entries: list[dict] = []
    group = ""
    for i, line in enumerate(lines):
        h2 = _H2_RE.match(line)
        if h2:
            group = h2.group("group")
            continue
        m = _ENTRY_RE.match(line)
        if m:
            entries.append({
                "title": m.group("title").strip(),
                "status": m.group("status"),
                "group": group,
                "line_index": i,
            })
    # Attach the body block (until the next entry / h2 / EOF) for slug & cites overrides.
    boundaries = [e["line_index"] for e in entries]
    for idx, e in enumerate(entries):
        start = e["line_index"]
        next_entry = boundaries[idx + 1] if idx + 1 < len(boundaries) else len(lines)
        # also stop at the next h2 heading
        end = next_entry
        for j in range(start + 1, next_entry):
            if _H2_RE.match(lines[j]):
                end = j
                break
        block = "\n".join(lines[start:end]).strip()
        e["block"] = block
        slug_override = _SLUG_COMMENT_RE.search(block)
        cites_override = _CITES_COMMENT_RE.search(block)
        e["slug"] = slug_override.group("slug") if slug_override else derive_slug(e["title"])
        if cites_override:
            e["cites"] = [c.strip() for c in cites_override.group("cites").split(",") if c.strip()]
        else:
            e["cites"] = CITATION_GRAPH.get(e["slug"], [])
    return entries


def has_notes(slug: str) -> bool:
    p = corpus_path(slug)
    return p.exists() and "\n## Notes" in p.read_text(encoding="utf-8")


def list_papers(session_states: dict[str, str] | None = None) -> list[Paper]:
    session_states = session_states or {}
    papers = []
    for e in _parse_entries():
        slug = e["slug"]
        papers.append(Paper(
            slug=slug,
            title=e["title"],
            group=e["group"],
            list_status=e["status"],
            cites=e["cites"],
            retrieved=corpus_path(slug).exists(),
            has_notes=has_notes(slug),
            session_state=session_states.get(slug),
        ))
    return papers


def get_paper(slug: str, session_states: dict[str, str] | None = None) -> Paper | None:
    for p in list_papers(session_states):
        if p.slug == slug:
            return p
    return None


def title_for(slug: str) -> str:
    p = get_paper(slug)
    return p.title if p else slug


def entry_markdown(slug: str) -> str:
    """The raw reading-list block for one paper (authors, venue, context, groups)."""
    for e in _parse_entries():
        if e["slug"] == slug:
            return e["block"]
    return ""


def reading_list_overview() -> str:
    """Compact list of every paper (group, title, status) so the agent can situate the
    current paper relative to the others."""
    lines, group = [], None
    for e in _parse_entries():
        if e["group"] != group:
            group = e["group"]
            lines.append(f"\n### {group}")
        lines.append(f"- {e['title']} — *{e['status']}* (slug: {e['slug']})")
    return "\n".join(lines).strip()


# ---- corpus full-text ----

def write_full_text(slug: str, title: str, full_text: str, meta: dict) -> Path:
    _corpus_dir().mkdir(parents=True, exist_ok=True)
    lines = [f"# {title}", ""]
    for k in ("slug", "arxiv_id", "source", "venue"):
        if meta.get(k):
            lines.append(f"- {k}: {meta[k]}")
    lines.append(f"- retrieved: {_now()}")
    lines += ["", "## Full text", "", full_text.strip(), ""]
    p = corpus_path(slug)
    atomic_write_text(p, "\n".join(lines))
    return p


def read_full_text(slug: str) -> str:
    """Return just the full-text body (without the Notes block, if present)."""
    p = corpus_path(slug)
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    marker = "\n## Full text\n"
    if marker in text:
        text = text.split(marker, 1)[1]
    if "\n## Notes" in text:
        text = text.split("\n## Notes", 1)[0]
    return text.strip()


def read_notes(slug: str) -> str:
    p = corpus_path(slug)
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    if "\n## Notes" in text:
        # The remainder starts mid-heading-line (e.g. "\n\nbody…"); reattach the heading on
        # its own line so the block is well-formed markdown.
        rest = text.split("\n## Notes", 1)[1]
        head, _, body = rest.partition("\n")
        return ("## Notes" + head).rstrip() + "\n\n" + body.strip()
    return ""


def all_committed_notes() -> list[tuple[str, str]]:
    """(title, Notes block) for every paper that has been read — for the working-notes review."""
    out = []
    for p in list_papers():
        if has_notes(p.slug):
            out.append((p.title, read_notes(p.slug)))
    return out


def selected_prior_notes(slug: str) -> list[tuple[str, str]]:
    """Notes blocks of cited papers that have been read. Falls back to all read papers
    when this paper has no recorded citations (small-corpus default)."""
    paper = get_paper(slug)
    if not paper:
        return []
    targets = paper.cites or [p.slug for p in list_papers() if p.slug != slug]
    out = []
    for t in targets:
        if has_notes(t):
            out.append((title_for(t), read_notes(t)))
    return out


# ---- committing notes (status flip + notes append) ----

def append_notes_block(slug: str, title: str, notes_block: str) -> None:
    p = corpus_path(slug)
    if not p.exists():
        write_full_text(slug, title, "(full text not cached)", {"slug": slug})
    text = p.read_text(encoding="utf-8")
    if "\n## Notes" in text:
        text = text.split("\n## Notes", 1)[0]  # replace an existing draft
    body = notes_block.strip()
    if not body.lower().startswith("## notes"):
        body = "## Notes\n\n" + body
    atomic_write_text(p, text.rstrip() + "\n\n" + body.strip() + "\n")


def set_status_read(slug: str) -> bool:
    """Flip the entry's italic status marker to *read* in reading-list.md."""
    entries = _parse_entries()
    target = next((e for e in entries if e["slug"] == slug), None)
    if not target:
        return False
    rl = _reading_list()
    lines = rl.read_text(encoding="utf-8").splitlines()
    i = target["line_index"]
    lines[i] = re.sub(r"\*unread\*", "*read*", lines[i])
    atomic_write_text(rl, "\n".join(lines) + "\n")
    return True


# ---- adding a paper (e.g. from a reference-graph recommendation) ----

class DuplicatePaperError(ValueError):
    pass


def add_entry(title: str, group: str = "Unsorted", arxiv_id: str | None = None) -> str:
    """Append a new *unread* reading-list entry under `group` (created if it doesn't exist
    yet). Returns the new entry's slug. Deliberately does NOT retrieve full text or git-commit
    — this only edits reading-list.md (metadata), matching the rest of this module's "never
    calls an LLM and never makes network calls" invariant; retrieval stays lazy (first time
    the paper is opened) like every other paper, and committing stays a human's explicit,
    reviewed action (committer.py), like every other change to a project's record."""
    title = (title or "").strip()
    if not title:
        raise ValueError("Title is required.")
    slug = derive_slug(title)
    if any(p.slug == slug for p in list_papers()):
        raise DuplicatePaperError(f"A paper with slug '{slug}' already exists in this project.")

    group = (group or "Unsorted").strip() or "Unsorted"
    heading = f"## {group}"
    rl = _reading_list()
    text = rl.read_text(encoding="utf-8") if rl.exists() else "# Reading list\n\n"
    lines = text.splitlines()

    block = [f"**{title}** — *unread*"]
    if arxiv_id:
        block.append(f"<!-- arxiv: {arxiv_id.strip()} -->")  # provenance only; not parsed
    block.append("")

    heading_idx = next((i for i, line in enumerate(lines) if line.strip() == heading), None)
    if heading_idx is not None:
        end = len(lines)
        for j in range(heading_idx + 1, len(lines)):
            if _H2_RE.match(lines[j]):
                end = j
                break
        new_lines = lines[:end] + block + lines[end:]
    else:
        new_lines = lines + ["", heading, ""] + block

    atomic_write_text(rl, "\n".join(new_lines).rstrip() + "\n")
    return slug
