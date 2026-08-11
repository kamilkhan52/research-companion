"""store.py cheap-read caches (§1.5): the reading-list parse and per-corpus has_notes check are
memoized by filesystem identity/version metadata, so list_papers()/get_paper() — called several
times per request, and once per project by projects.list_projects() — stop re-parsing
reading-list.md and re-reading whole (hundreds-of-KB) corpus files on every call. A cached value
is only served while the file's version signal is unchanged; writes through the store and
external editor replacements both yield a fresh read. Network-free."""
from __future__ import annotations

import os

from app import store
from app.fileio import atomic_write_text

from tests.conftest import add_paper


def _spy(monkeypatch, name):
    """Wrap store.<name> with a call counter, delegating to the original implementation."""
    original = getattr(store, name)
    calls = {"n": 0}

    def wrapper(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(store, name, wrapper)
    return calls


# ---- reading-list parse cache ----

def test_parse_entries_reparses_at_most_once_until_change(temp_project, monkeypatch):
    add_paper(temp_project, "a", "Paper A", full_text="t")
    calls = _spy(monkeypatch, "_parse_entries_uncached")

    # Repeated reads over an unchanged file parse it exactly once.
    assert {p.slug for p in store.list_papers()} == {"a"}
    store.get_paper("a")
    store.list_papers()
    assert calls["n"] == 1

    # A write through the store invalidates, so the new entry is visible immediately.
    store.add_entry("Paper B", group="Group")
    assert {p.slug for p in store.list_papers()} == {"a", "paper-b"}
    assert calls["n"] == 2  # reparsed exactly once more


def test_set_status_read_is_visible_immediately(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="t")
    assert store.get_paper("a").list_status == "unread"
    assert store.set_status_read("a") is True
    # Read-after-write in the same request must not serve the stale (unread) parse.
    assert store.get_paper("a").list_status == "read"


def test_external_edit_is_picked_up_via_mtime(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="t")
    assert {p.slug for p in store.list_papers()} == {"a"}
    # A write that bypasses the store's writers (e.g. an editor, or git) still changes the
    # file's (mtime, size), so the cache key no longer matches and we re-parse.
    rl = store._reading_list()
    rl.write_text(rl.read_text(encoding="utf-8") + "\n**Paper Z** — *unread*\n", encoding="utf-8")
    assert "paper-z" in {p.slug for p in store.list_papers()}


def test_external_same_size_replacement_with_preserved_mtime_is_picked_up(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="t")
    assert {p.slug for p in store.list_papers()} == {"a"}

    # Some editors replace a file atomically and may preserve its mtime. If the new content has
    # the same size, an (mtime, size)-only cache key would incorrectly serve the old parse. The
    # replacement inode/ctime must still invalidate it.
    rl = store._reading_list()
    before = rl.stat()
    changed = rl.read_text(encoding="utf-8").replace("<!-- slug: a -->", "<!-- slug: z -->")
    atomic_write_text(rl, changed)
    os.utime(rl, ns=(before.st_atime_ns, before.st_mtime_ns))

    assert {p.slug for p in store.list_papers()} == {"z"}


# ---- source_url_for cache + head scan ----
# PR #370 put list_papers() (and so source_url_for, via source_url_for(slug) in list_papers'
# per-paper loop) on Discover's ~1.5s poll path. The previous implementation read the entire
# corpus file on every call just to grab a meta line from its first 2000 characters.

def test_source_url_for_scans_at_most_once_until_corpus_changes(temp_project, monkeypatch):
    store.write_full_text("a", "Paper A", "body", {"slug": "a", "source": "https://x.test/a.pdf"})
    calls = _spy(monkeypatch, "_scan_for_source_url")

    assert store.source_url_for("a") == "https://x.test/a.pdf"
    store.source_url_for("a")
    assert calls["n"] == 1       # one scan, then cached

    store.write_full_text("a", "Paper A", "body", {"slug": "a", "source": "https://x.test/b.pdf"})
    assert store.source_url_for("a") == "https://x.test/b.pdf"   # invalidated by the write
    assert calls["n"] == 2


def test_source_url_for_correct_when_the_meta_header_sits_beyond_a_naive_slice(temp_project):
    # A very long title pushes the "- source:" line past the old code's read pattern only if
    # read_text()[:2000] and a bounded byte-read disagree about where the header actually is —
    # they shouldn't, since the header is always written first, but this pins that invariant
    # against a title long enough to matter.
    long_title = "T" * 500
    store.write_full_text(
        "a", long_title, "body" * 5000, {"slug": "a", "source": "https://x.test/a.pdf"},
    )
    assert store.source_url_for("a") == "https://x.test/a.pdf"


def test_source_url_for_empty_when_no_source_recorded(temp_project):
    store.write_full_text("a", "Paper A", "body", {"slug": "a"})
    assert store.source_url_for("a") == ""


# ---- has_notes cache + tail scan ----

def test_has_notes_scans_at_most_once_until_corpus_changes(temp_project, monkeypatch):
    add_paper(temp_project, "a", "Paper A", full_text="body")
    calls = _spy(monkeypatch, "_scan_for_notes")

    assert store.has_notes("a") is False
    store.has_notes("a")
    store.list_papers()          # also consults has_notes
    assert calls["n"] == 1       # one scan, then cached

    store.append_notes_block("a", "Paper A", "## Notes\n\nGreat paper.")
    assert store.has_notes("a") is True   # invalidated by the write
    assert calls["n"] == 2


def test_has_notes_passes_actual_file_size_to_scanner(temp_project, monkeypatch):
    add_paper(temp_project, "large", "Large Paper", full_text="word " * 40_000)
    path = store.corpus_path("large")
    observed: list[int] = []
    original = store._scan_for_notes

    def capture_size(p, size):
        observed.append(size)
        return original(p, size)

    monkeypatch.setattr(store, "_scan_for_notes", capture_size)

    assert store.has_notes("large") is False
    assert observed == [path.stat().st_size]


def test_has_notes_correct_across_the_tail_boundary(temp_project):
    big = "word " * 40_000   # ~200 KB, comfortably larger than the 64 KiB tail window

    # (1) large full text, no notes -> False (tail miss falls back to a full scan).
    add_paper(temp_project, "big-none", "Big None", full_text=big)
    assert store.has_notes("big-none") is False

    # (2) large full text with a normal trailing notes block -> found in the tail.
    add_paper(temp_project, "big-notes", "Big Notes", full_text=big)
    store.append_notes_block("big-notes", "Big Notes", "## Notes\n\nShort note.")
    assert store.has_notes("big-notes") is True

    # (3) notes block itself larger than the tail window -> marker sits above the tail, so the
    #     full-scan fallback is what makes the answer correct.
    add_paper(temp_project, "huge-notes", "Huge Notes", full_text="small")
    store.append_notes_block("huge-notes", "Huge Notes", "## Notes\n\n" + ("note " * 20_000))
    assert store.has_notes("huge-notes") is True


def test_caches_do_not_collide_across_projects(temp_project):
    from app import config, projects

    add_paper(temp_project, "a", "Paper A", full_text="t")   # unread, no notes in project 1
    assert store.get_paper("a").list_status == "unread"
    assert store.has_notes("a") is False

    # A second project reusing the same slug must resolve against ITS OWN files (caches are
    # keyed by absolute path), not serve project 1's cached parse/has_notes.
    pid2 = projects.create_project("Second")["id"]
    token = config.set_active_project(pid2)
    try:
        add_paper(pid2, "a", "Paper A", full_text="t")
        store.append_notes_block("a", "Paper A", "## Notes\n\nNoted.")
        store.set_status_read("a")
        assert store.get_paper("a").list_status == "read"
        assert store.has_notes("a") is True
    finally:
        config.reset_active_project(token)

    # Back in project 1, nothing leaked from project 2.
    assert store.get_paper("a").list_status == "unread"
    assert store.has_notes("a") is False
