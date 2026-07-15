"""The persistent store: plain markdown in a git repo (Section 8).

Parses reading-list.md into a paper index, derives stable slugs, exposes the citation
graph used for context selection, and reads/writes corpus files and synthesis.md. This
module never calls an LLM and never makes network calls — it is pure spine.
"""
from __future__ import annotations

import re
import textwrap
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

from . import config
from .fileio import atomic_write_text
from .models import Paper


# ---- cheap-read caches (see §1.5) ---------------------------------------------------------
# store.py is on the hot path: list_papers()/get_paper() run several times per request and
# projects.list_projects() runs list_papers() once per project. Re-parsing reading-list.md and
# re-reading every (often hundreds-of-KB) corpus file on *every* call — has_notes() read the
# whole paper text just to find a trailing "## Notes" marker — is a visible tax at 200 papers ×
# several projects. We memoize by filesystem identity/version metadata. Writers in this module
# also invalidate the affected entry explicitly, so a read-after-write within the same request
# is never stale even where the filesystem's mtime granularity is coarse. Device+inode catch an
# atomic replacement whose size and mtime were preserved; ctime catches an in-place same-size
# rewrite with a restored mtime. Keyed by absolute path, so distinct projects (and their distinct
# reading-list/corpus paths) never collide. Single-process by design (CLAUDE.md invariant 6): a
# concurrent cache miss may recompute redundantly, but the key is checked again on the next read.
class _FileKey(NamedTuple):
    device: int
    inode: int
    mtime_ns: int
    ctime_ns: int
    size: int


_parse_cache: dict[str, tuple[_FileKey, list[dict]]] = {}
_notes_cache: dict[str, tuple[_FileKey, bool]] = {}

# Serializes every reading-list.md read-modify-write (add_entry, set_abstract, annotate_entry).
# Background retrieval jobs for different papers finish concurrently and annotate their
# entries; without the lock the last writer's whole-file atomic replace silently discards the
# other's insertion. One process (CLAUDE.md invariant 6), so a plain module lock suffices; the
# reading-list path is per-project via the active-project contextvar, and a single lock across
# projects only costs needless-but-harmless serialization.
_RL_LOCK = threading.RLock()


def _file_key(p: Path) -> _FileKey | None:
    """Filesystem identity/version signal for a file, or None if it doesn't exist."""
    try:
        st = p.stat()
    except OSError:
        return None
    return _FileKey(st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)


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
_ARXIV_COMMENT_RE = re.compile(r"<!--\s*arxiv:\s*(?P<arxiv_id>[^\s>]+?)\s*-->", re.I)
_YEAR_COMMENT_RE = re.compile(r"<!--\s*year:\s*(?P<year>\d{4})\s*-->", re.I)
_COMMENT_LINE_RE = re.compile(r"^\s*<!--.*-->\s*$")
_ABSTRACT_LABEL_RE = re.compile(r"^Abstract:\s*(?P<head>.*)$", re.I)

# An entry's abstract is a labelled paragraph inside its block, in the same style as the
# `Authors:` / `Context & adoption:` paragraphs that projects already hand-write:
#
#     **Orca: A Distributed Serving System...** — *unread*
#     <!-- arxiv: 2201.11705 -->
#
#     Abstract: Large-scale Transformer-based models...
#
# It runs to the next blank line, so it is wrapped prose a human can read and edit. Abstracts
# give the agent something to reason about for papers nobody has read yet — an unread entry
# otherwise reaches a discussion as a bare title (see reading_list_overview).
_ABSTRACT_WRAP_COLS = 95

# Slug derivation and citation links (which prior Notes to auto-load) are BOTH per-project
# content authored in reading-list.md, not application data: pin a non-obvious slug with an
# entry's `<!-- slug: my-slug -->` comment, and declare its citations with `<!-- cites: a, b -->`
# (see the machine-readable note at the top of any project's reading-list.md). Nothing about a
# specific project's papers is hardcoded here — a project whose slugs happen to collide with
# another's can't inherit the wrong citations. `scripts/migrate_citation_annotations.py` moved
# the original llm-inference-serving constants into that project's file.


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# arXiv ids date a paper for free: new-style `YYMM.NNNNN` (2007-present) and old-style
# `archive/YYMMNNN` (1991-2007) both open with a two-digit year and month.
_ARXIV_NEW_ID_RE = re.compile(r"^(\d{2})(\d{2})\.\d{4,5}")
_ARXIV_OLD_ID_RE = re.compile(r"^[a-z-]+(?:\.[A-Z]{2})?/(\d{2})(\d{2})\d{3}", re.I)


def year_from_arxiv_id(arxiv_id: str) -> int | None:
    """Publication year encoded in an arXiv id (the month the first version appeared), or
    None when the id is absent/unrecognized. Pure string parsing — no network."""
    aid = (arxiv_id or "").strip()
    m = _ARXIV_NEW_ID_RE.match(aid)
    if m:
        return 2000 + int(m.group(1))
    m = _ARXIV_OLD_ID_RE.match(aid)
    if m:
        yy = int(m.group(1))
        return 1900 + yy if yy >= 91 else 2000 + yy
    return None


def derive_slug(title: str) -> str:
    """The system name before the first colon, slugified (e.g. 'Orca: A ...' -> 'orca'). When a
    title's slug can't be derived this way, pin it in reading-list.md with `<!-- slug: ... -->`."""
    head = title.split(":")[0]
    slug = re.sub(r"[^a-z0-9]+", "-", head.lower()).strip("-")
    return slug or re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48]


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
    """Reading-list entries (title, status, group, slug, cites, raw block), memoized by the
    file's identity/version key so repeated list_papers()/get_paper() calls in a request
    re-parse at most once. The returned list is treated as read-only by all callers (they build
    Paper objects or read fields); do not mutate it, as it is shared with the cache."""
    rl = _reading_list()
    key = _file_key(rl)
    if key is not None:
        hit = _parse_cache.get(str(rl))
        if hit is not None and hit[0] == key:
            return hit[1]
    entries = _parse_entries_uncached(rl)
    if key is not None:
        _parse_cache[str(rl)] = (key, entries)
    return entries


def _parse_entries_uncached(rl: Path) -> list[dict]:
    """Return entries with title, status, group, slug, cites, arxiv_id, abstract, and the raw
    text block (plus the block's [line_index, end_index) extent, which set_abstract rewrites)."""
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
        block_lines = lines[start:end]
        e["end_index"] = end
        e["block"] = "\n".join(block_lines).strip()
        slug_override = _SLUG_COMMENT_RE.search(e["block"])
        cites_override = _CITES_COMMENT_RE.search(e["block"])
        arxiv = _ARXIV_COMMENT_RE.search(e["block"])
        e["slug"] = slug_override.group("slug") if slug_override else derive_slug(e["title"])
        if cites_override:
            e["cites"] = [c.strip() for c in cites_override.group("cites").split(",") if c.strip()]
        else:
            e["cites"] = []
        e["arxiv_id"] = arxiv.group("arxiv_id") if arxiv else ""
        # Publication year: an explicit `<!-- year: 2019 -->` (the escape hatch for non-arXiv
        # papers) wins over the year encoded in the arXiv id.
        year_c = _YEAR_COMMENT_RE.search(e["block"])
        e["year"] = int(year_c.group("year")) if year_c else year_from_arxiv_id(e["arxiv_id"])
        e["abstract"] = _extract_abstract(block_lines)
    return entries


def _abstract_span(block_lines: list[str]) -> tuple[int, int] | None:
    """The [start, end) extent of the `Abstract:` paragraph within a block's lines, or None.
    The paragraph runs from the labelled line to the next blank line or the block's end."""
    for i, line in enumerate(block_lines):
        if _ABSTRACT_LABEL_RE.match(line):
            end = len(block_lines)
            for j in range(i + 1, len(block_lines)):
                if not block_lines[j].strip():
                    end = j
                    break
            return (i, end)
    return None


def _extract_abstract(block_lines: list[str]) -> str:
    """The abstract as a single unwrapped line ("" when the entry has none)."""
    span = _abstract_span(block_lines)
    if span is None:
        return ""
    start, end = span
    head = _ABSTRACT_LABEL_RE.match(block_lines[start]).group("head")
    para = " ".join([head, *(line.strip() for line in block_lines[start + 1:end])])
    return re.sub(r"\s+", " ", para).strip()


_NOTES_MARKER = b"\n## Notes"
_NOTES_TAIL = 64 * 1024   # notes are appended last, so this tail almost always catches the marker


def has_notes(slug: str) -> bool:
    """Whether a paper's corpus file carries a committed Notes block, memoized by the file's
    (mtime, size). The former implementation read the *entire* corpus file (the full paper
    text, often hundreds of KB) on every call, once per paper inside list_papers()."""
    p = corpus_path(slug)
    key = _file_key(p)
    if key is None:
        _notes_cache.pop(str(p), None)
        return False
    hit = _notes_cache.get(str(p))
    if hit is not None and hit[0] == key:
        return hit[1]
    result = _scan_for_notes(p, key.size)
    _notes_cache[str(p)] = (key, result)
    return result


def _scan_for_notes(p: Path, size: int) -> bool:
    """Look for the trailing "## Notes" marker. The notes block is always the final section
    (append_notes_block writes it after the full text), so its marker sits in the file tail:
    scanning the last _NOTES_TAIL bytes finds it in the common case. A present marker there is
    conclusive; absence is only conclusive once we've scanned the whole file, so on a tail miss
    of a larger file we fall back to a full read (rare, and cached thereafter)."""
    with p.open("rb") as f:
        if size > _NOTES_TAIL:
            f.seek(size - _NOTES_TAIL)
            if _NOTES_MARKER in f.read():
                return True
            f.seek(0)   # tail miss on a large file: confirm absence with a full scan
        return _NOTES_MARKER in f.read()


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
            arxiv_id=e["arxiv_id"],
            source_url=source_url_for(slug),
            year=e["year"],
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
    """The raw reading-list block for one paper (authors, venue, context, groups, abstract)."""
    for e in _parse_entries():
        if e["slug"] == slug:
            return e["block"]
    return ""


def abstract_for(slug: str) -> str:
    """The stored abstract for one paper as a single line ("" when the entry has none)."""
    for e in _parse_entries():
        if e["slug"] == slug:
            return e["abstract"]
    return ""


def arxiv_id_for(slug: str) -> str:
    """The entry's `<!-- arxiv: ... -->` id, if it has one."""
    for e in _parse_entries():
        if e["slug"] == slug:
            return e["arxiv_id"]
    return ""


def year_for(slug: str) -> int | None:
    """The entry's publication year (explicit comment or arXiv id), or None."""
    for e in _parse_entries():
        if e["slug"] == slug:
            return e["year"]
    return None


_SOURCE_META_RE = re.compile(r"^- source:\s*(?P<url>\S+)", re.M)
_CORPUS_ARXIV_RE = re.compile(r"^- arxiv_id:\s*(?P<aid>\S+)", re.M)


def corpus_arxiv_id_for(slug: str) -> str:
    """The arXiv id recorded in the corpus meta header at retrieval time ("" if none / not
    retrieved). Papers retrieved before annotate_entry existed carry their resolved id only
    here — the year backfill reads it back onto the entry."""
    p = corpus_path(slug)
    if not p.exists():
        return ""
    m = _CORPUS_ARXIV_RE.search(p.read_text(encoding="utf-8", errors="ignore")[:2000])
    return m.group("aid").strip() if m else ""


def source_url_for(slug: str) -> str:
    """The source URL recorded in the corpus file's meta header ("" if none / not retrieved).
    Set when the paper was retrieved from an explicit PDF/abstract URL rather than an arXiv id;
    lets callers that need the original PDF (e.g. cover rendering) recover it for non-arXiv
    papers. Deterministic file read — no network (invariant 3)."""
    p = corpus_path(slug)
    if not p.exists():
        return ""
    m = _SOURCE_META_RE.search(p.read_text(encoding="utf-8", errors="ignore")[:2000])
    return m.group("url").strip() if m else ""


def reading_list_overview() -> str:
    """Compact list of every paper (group, title, status) so the agent can situate the
    current paper relative to the others.

    A paper that has been read contributes its whole Notes block to the context separately, so
    here we just name it. A paper that has *not* been read contributes nothing else anywhere —
    so its abstract rides along here, and is the only thing that lets a discussion say something
    substantive about a paper still on the to-read pile."""
    lines, group = [], None
    for e in _parse_entries():
        if e["group"] != group:
            group = e["group"]
            lines.append(f"\n### {group}")
        # The year rides along so the agent can situate every paper on the corpus timeline
        # (what predates/postdates what) without asking.
        year = f" ({e['year']})" if e["year"] else ""
        lines.append(f"- {e['title']}{year} — *{e['status']}* (slug: {e['slug']}; "
                     f"link: rc-paper:{e['slug']})")
        if e["abstract"] and not has_notes(e["slug"]):
            lines.append(f"  Abstract: {e['abstract']}")
    return "\n".join(lines).strip()


def _abstract_paragraph(abstract: str) -> list[str]:
    """The `Abstract:` paragraph as wrapped file lines. Never break inside a token: _extract_
    abstract unwraps by joining lines with a space, so a line ending mid-word round-trips as
    "3D DRAM- stacked" (hyphens) or a mangled URL. Abstracts are dense with both."""
    return textwrap.wrap(f"Abstract: {abstract}", width=_ABSTRACT_WRAP_COLS,
                         break_on_hyphens=False, break_long_words=False)


def set_abstract(slug: str, abstract: str) -> bool:
    """Write (or replace) an entry's `Abstract:` paragraph in reading-list.md. Returns False
    when no entry carries that slug. Deterministic and offline like the rest of this module —
    a caller that must *fetch* an abstract does so in the retriever layer (invariant 3)."""
    abstract = re.sub(r"\s+", " ", abstract or "").strip()
    if not abstract:
        raise ValueError("Abstract is empty.")
    with _RL_LOCK:
        return _set_abstract_locked(slug, abstract)


def _set_abstract_locked(slug: str, abstract: str) -> bool:
    target = next((e for e in _parse_entries() if e["slug"] == slug), None)
    if not target:
        return False

    rl = _reading_list()
    lines = rl.read_text(encoding="utf-8").splitlines()
    start, end = target["line_index"], target["end_index"]
    block = lines[start:end]
    para = _abstract_paragraph(abstract)

    span = _abstract_span(block)
    if span is not None:
        block[span[0]:span[1]] = para
    else:
        # Insert as its own paragraph, after the title line and any comments pinned beneath it.
        i = 1
        while i < len(block) and _COMMENT_LINE_RE.match(block[i]):
            i += 1
        head, rest = block[:i], block[i:]
        while rest and not rest[0].strip():
            rest.pop(0)          # the blank that separated the head from the body; we re-add it
        block = head + ["", *para] + (["", *rest] if rest else [])
    if end < len(lines) and block[-1].strip():
        block.append("")         # keep the blank line that separates us from the next entry

    atomic_write_text(rl, "\n".join(lines[:start] + block + lines[end:]).rstrip() + "\n")
    _parse_cache.pop(str(rl), None)   # the entry block changed — drop the stale parse
    return True


def _arxiv_base_id(arxiv_id: str) -> str:
    """The id without a version suffix — `2211.10438v3` and `2211.10438` are the same paper."""
    return re.sub(r"v\d+$", "", (arxiv_id or "").strip(), flags=re.I)


def annotate_entry(slug: str, *, arxiv_id: str | None = None, year: int | None = None,
                   authoritative: bool = False) -> bool:
    """Record identity metadata (`<!-- arxiv -->` / `<!-- year -->` comments) on an entry.

    Default mode inserts only what's MISSING — existing values may be human-pinned and are
    never touched, and a year comment is skipped when the entry's effective arXiv id already
    dates the paper. `authoritative=True` (an id the user explicitly supplied to a retrieval)
    additionally REPLACES a conflicting arxiv comment — the machine-resolved id it corrects
    must not outlive the correction — and drops a year comment the new id contradicts.
    Returns True if the file changed. Metadata-only edit like add_entry/set_abstract:
    uncommitted, deterministic, offline. Serialized by _RL_LOCK: concurrent retrieval jobs
    finish independently and must not lose each other's read-modify-write."""
    with _RL_LOCK:
        target = next((e for e in _parse_entries() if e["slug"] == slug), None)
        if not target:
            return False

        rl = _reading_list()
        lines = rl.read_text(encoding="utf-8").splitlines()
        start, end = target["line_index"], target["end_index"]
        block = lines[start:end]
        changed = False

        def insert_comment(comment: str) -> None:
            # After the title line and any comments already pinned beneath it (add_entry's spot).
            pos = 1
            while pos < len(block) and _COMMENT_LINE_RE.match(block[pos]):
                pos += 1
            block.insert(pos, comment)

        effective_id = target["arxiv_id"]
        new_id = (arxiv_id or "").strip()
        if new_id and not effective_id:
            insert_comment(f"<!-- arxiv: {new_id} -->")
            effective_id = new_id
            changed = True
        elif (authoritative and new_id and effective_id
              and _arxiv_base_id(new_id) != _arxiv_base_id(effective_id)):
            # Correcting a wrong identity: replace the old comment in place.
            for i, line in enumerate(block):
                if _ARXIV_COMMENT_RE.search(line):
                    block[i] = _ARXIV_COMMENT_RE.sub(f"<!-- arxiv: {new_id} -->", line)
                    break
            effective_id = new_id
            changed = True

        derived = year_from_arxiv_id(effective_id)
        has_year_comment = any(_YEAR_COMMENT_RE.search(line) for line in block)
        if authoritative and derived and has_year_comment and target["year"] != derived:
            # The year comment described the (corrected-away) wrong identity.
            block = [line for line in block if not _YEAR_COMMENT_RE.search(line)]
            has_year_comment = False
            changed = True
        if year and 1900 <= year <= 2100 and not derived and not has_year_comment:
            insert_comment(f"<!-- year: {year} -->")
            changed = True

        if not changed:
            return False
        atomic_write_text(rl, "\n".join(lines[:start] + block + lines[end:]).rstrip() + "\n")
        _parse_cache.pop(str(rl), None)
        return True


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
    _notes_cache.pop(str(p), None)   # content changed — drop any stale has_notes verdict
    # Retrieval often RESOLVES the paper's identity (a title search found the arXiv id) that
    # the reading-list entry never had — record it there too, so the entry gains its year and
    # every id-keyed feature (backfill, graph matching) sees it. Never overwrites a pinned id.
    if meta.get("arxiv_id"):
        annotate_entry(slug, arxiv_id=str(meta["arxiv_id"]))
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
    _notes_cache.pop(str(p), None)   # a Notes block was just added/replaced


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
    _parse_cache.pop(str(rl), None)   # status changed — drop the stale parse
    return True


# ---- adding a paper (e.g. from a reference-graph recommendation) ----

class DuplicatePaperError(ValueError):
    pass


def add_entry(title: str, group: str = "Unsorted", arxiv_id: str | None = None,
              abstract: str | None = None, year: int | None = None) -> str:
    """Append a new *unread* reading-list entry under `group` (created if it doesn't exist
    yet). Returns the new entry's slug. Deliberately does NOT retrieve full text or git-commit
    — this only edits reading-list.md (metadata), matching the rest of this module's "never
    calls an LLM and never makes network calls" invariant; retrieval stays lazy (first time
    the paper is opened) like every other paper, and committing stays a human's explicit,
    reviewed action (committer.py), like every other change to a project's record.

    The caller passes `abstract` when it already has one (Discover searched arXiv to find this
    paper, so it does). Otherwise the entry starts abstract-less and
    `scripts/backfill_abstracts.py` can fill it in later."""
    title = (title or "").strip()
    if not title:
        raise ValueError("Title is required.")
    with _RL_LOCK:
        return _add_entry_locked(title, group, arxiv_id, abstract, year)


def _add_entry_locked(title: str, group: str, arxiv_id: str | None,
                      abstract: str | None, year: int | None) -> str:
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
        block.append(f"<!-- arxiv: {arxiv_id.strip()} -->")
    # Record the year only when the arXiv id can't already date the paper — the comment is
    # the non-arXiv escape hatch, not a duplicate of what the id encodes.
    if year and 1900 <= year <= 2100 and not year_from_arxiv_id(arxiv_id or ""):
        block.append(f"<!-- year: {year} -->")
    abstract = re.sub(r"\s+", " ", abstract or "").strip()
    if abstract:
        block += ["", *_abstract_paragraph(abstract)]
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
    _parse_cache.pop(str(rl), None)   # a new entry was appended
    return slug


# ---- removing a paper ----

def remove_entry(slug: str) -> bool:
    """Delete the entry's block from reading-list.md (metadata only). Returns False when no
    entry carries that slug. Everything else the paper left on disk — corpus text, a committed
    Notes block, session transcript — deliberately stays: it is cheap, keeps the notes'
    history intact, and makes re-adding the paper later a warm start. Like add_entry, this
    does NOT git-commit; the removal endpoint commits the human-confirmed change."""
    with _RL_LOCK:
        return _remove_entry_locked(slug)


def _remove_entry_locked(slug: str) -> bool:
    target = next((e for e in _parse_entries() if e["slug"] == slug), None)
    if not target:
        return False
    rl = _reading_list()
    lines = rl.read_text(encoding="utf-8").splitlines()
    start, end = target["line_index"], target["end_index"]
    # Trailing blank separator lines belong to the block being removed.
    while end < len(lines) and not lines[end].strip():
        end += 1
    del lines[start:end]
    atomic_write_text(rl, "\n".join(lines).rstrip() + "\n")
    _parse_cache.pop(str(rl), None)   # an entry was removed
    return True


def append_removed_marker(slug: str) -> None:
    """Record inside the paper's retained Notes block that the paper left the reading list
    (the product decision is keep-notes-on-removal; the marker keeps the retained notes
    honest when read later). No-op when the paper has no committed notes."""
    if not has_notes(slug):
        return
    p = corpus_path(slug)
    stamp = datetime.now(UTC).date().isoformat()
    marker = f"> Removed from the reading list on {stamp}. Notes retained."
    text = p.read_text(encoding="utf-8")
    atomic_write_text(p, text.rstrip() + "\n\n" + marker + "\n")
    _notes_cache.pop(str(p), None)   # content changed — drop the memoized verdict
