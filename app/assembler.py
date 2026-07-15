"""Context assembler (Section 7). Builds the small, relevant working context for a turn:
the reading method, the running synthesis, the selected prior Notes (via the citation
graph), the reading-list overview, and this paper's metadata. The current paper's full
text and the session history are carried by the session itself (see sessions.py), so they
are assembled once at session start rather than rebuilt here every turn.
"""
from __future__ import annotations

from . import config, graph, prompts, store
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
    parts.append("# The full reading list (papers not yet read carry their abstract)\n\n"
                 "(Whenever you name ANY paper on this list, render that name as a markdown link "
                 "to its `link:` target below (an `rc-paper:<slug>`), verbatim — including in the "
                 "rewritten SYNTHESIS — so the reader can tap it. Link the first mention in each "
                 "section; never invent a slug for a paper that isn't listed.)\n\n"
                 + store.reading_list_overview())
    return "\n\n---\n\n".join(parts)


def build_context(slug: str) -> str:
    if slug == REVIEW_SLUG:
        return build_review_context()
    parts: list[str] = []

    parts.append("# Reading method (follow this exactly)\n\n" + store.read_method().strip())

    parts.append("# Working notes — the running cross-paper synthesis so far\n\n"
                 + store.read_synthesis().strip())

    # Which prior per-paper Notes to include: the citation-related selection (compact, the
    # default), or every paper read so far (prior_notes_scope="all" — richer cross-paper
    # grounding for a single-project workflow, at the cost of a larger context per turn).
    scope = (config.load_settings().get("prior_notes_scope") or "related").strip().lower()
    if scope == "all":
        prior = [(p.title, store.read_notes(p.slug))
                 for p in store.list_papers() if p.slug != slug and store.has_notes(p.slug)]
        header = ["# Prior Notes from every paper read so far in this project",
                  "(All committed per-paper Notes; lean on these to situate the current paper.)"]
        empty = "# Prior Notes\n\nNone yet — no paper on the list has been read in full."
    else:
        prior = store.selected_prior_notes(slug)
        header = ["# Prior Notes from related papers already read",
                  "(Selected via the citation graph; lean on these to situate the current paper.)"]
        empty = ("# Prior Notes from related papers\n\n"
                 "None yet — no related paper on the list has been read in full.")
    if prior:
        block = list(header)
        for title, notes in prior:
            block.append(f"\n## {title}\n\n{notes.strip()}")
        parts.append("\n".join(block))
    else:
        parts.append(empty)

    related = graph.related_works_for(slug)
    if related:
        block = ["# Significant related works (shown to the reader in this session's "
                 "'Related works' menu)",
                 "(From the project's reference graph. When a related work below is relevant to "
                 "the discussion, refer to it by name AND render that name as a markdown link to "
                 "its `link:` target given below, so the reader can tap straight through — an "
                 "in-project paper opens its own discussion thread; an external one opens its "
                 "source. Example: [Attention Is All You Need](rc-paper:attention-is-all-you-need). "
                 "Use the target verbatim. You may still note the item is in the Related works "
                 "menu.)"]
        for r in related:
            status = ("in this project, read" if r["kind"] == "project" and r["list_status"] == "read"
                      else "in this project, unread" if r["kind"] == "project" else "external")
            cites = f"; ~{r['citation_count']:,} citations" if r.get("citation_count") else ""
            rel = "this paper builds on it" if r["direction"] == "builds_on" else "it builds on this paper"
            if r["kind"] == "project" and r.get("slug"):
                target = f"rc-paper:{r['slug']}"
            elif r.get("url"):
                target = r["url"]
            elif r.get("arxiv_id"):
                target = f"https://arxiv.org/abs/{r['arxiv_id']}"
            else:
                target = ""
            link = f" link:{target}" if target else ""
            block.append(f"- \"{r['title']}\" ({r.get('year') or 'n.d.'}; {status}{cites}) — "
                         f"{rel}: {r['reason']}{link}")
        parts.append("\n".join(block))

    parts.append("# The full reading list (for situating this paper)\n\n"
                 "(Entries not yet read carry their abstract — enough to speak to how they "
                 "relate to this paper, but not a substitute for having read them. Entries "
                 "already read contribute their Notes above instead. Whenever you name ANY paper "
                 "on this list — not only the related works above — render that name as a markdown "
                 "link to its `link:` target given below (an `rc-paper:<slug>`), verbatim, so the "
                 "reader can tap it to open that paper in the app. Link the first mention in each "
                 "section; you need not relink every repeat.)\n\n"
                 + store.reading_list_overview())

    entry = store.entry_markdown(slug)
    if entry:
        head = "# This paper's reading-list entry (authors, venue, context)\n\n"
        year = store.year_for(slug)
        if year:
            # Stated explicitly (not only encoded in the arXiv id) so the discussion reliably
            # situates the paper on the timeline: what existed before it, what came after.
            head += (f"Published: {year}. Situate the paper in time — note which related "
                     "works predate or postdate it when weighing its contributions.\n\n")
        parts.append(head + entry)

    return "\n\n---\n\n".join(parts)


def paper_opening_message(slug: str, full_text: str) -> str:
    """The first user message of a session: hands the agent the paper text and asks for the
    opening comprehensive summary. The template is user-editable (prompts.opening_message)."""
    return prompts.render("opening_message", title=store.title_for(slug),
                          full_text=full_text.strip())
