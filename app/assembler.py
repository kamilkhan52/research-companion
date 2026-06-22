"""Context assembler (Section 7). Builds the small, relevant working context for a turn:
the reading method, the running synthesis, the selected prior Notes (via the citation
graph), the reading-list overview, and this paper's metadata. The current paper's full
text and the session history are carried by the session itself (see sessions.py), so they
are assembled once at session start rather than rebuilt here every turn.
"""
from __future__ import annotations

from . import prompts, store
from .models import REVIEW_SLUG


def build_review_context() -> str:
    """Aggregate context for the Working Notes Review chat: the reading method, the current
    working notes, every per-paper Notes block read so far, and the reading list."""
    parts = ["# Reading method (follow this exactly)\n\n" + store.read_method().strip()]
    parts.append("# Working notes — the running cross-paper synthesis so far\n\n"
                 + store.read_synthesis().strip())
    notes = store.all_committed_notes()
    if notes:
        block = ["# Per-paper Notes for every paper read so far"]
        for title, n in notes:
            block.append(f"\n## {title}\n\n{n.strip()}")
        parts.append("\n".join(block))
    else:
        parts.append("# Per-paper Notes\n\nNo papers have been read in full yet.")
    parts.append("# The full reading list\n\n" + store.reading_list_overview())
    return "\n\n---\n\n".join(parts)


def build_context(slug: str) -> str:
    if slug == REVIEW_SLUG:
        return build_review_context()
    parts: list[str] = []

    parts.append("# Reading method (follow this exactly)\n\n" + store.read_method().strip())

    parts.append("# Working notes — the running cross-paper synthesis so far\n\n"
                 + store.read_synthesis().strip())

    prior = store.selected_prior_notes(slug)
    if prior:
        block = ["# Prior Notes from related papers already read",
                 "(Selected via the citation graph; lean on these to situate the current paper.)"]
        for title, notes in prior:
            block.append(f"\n## {title}\n\n{notes.strip()}")
        parts.append("\n".join(block))
    else:
        parts.append("# Prior Notes from related papers\n\n"
                     "None yet — no related paper on the list has been read in full.")

    parts.append("# The full reading list (for situating this paper)\n\n"
                 + store.reading_list_overview())

    entry = store.entry_markdown(slug)
    if entry:
        parts.append("# This paper's reading-list entry (authors, venue, context)\n\n" + entry)

    return "\n\n---\n\n".join(parts)


def paper_opening_message(slug: str, full_text: str) -> str:
    """The first user message of a session: hands the agent the paper text and asks for the
    opening comprehensive summary. The template is user-editable (prompts.opening_message)."""
    return prompts.render("opening_message", title=store.title_for(slug),
                          full_text=full_text.strip())
