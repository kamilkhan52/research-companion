"""Context assembler (Section 7). Builds the small, relevant working context for a turn:
the reading method, the running synthesis, the selected prior Notes (via the citation
graph), the reading-list overview, and this paper's metadata. The current paper's full
text and the session history are carried by the session itself (see sessions.py), so they
are assembled once at session start rather than rebuilt here every turn.
"""
from __future__ import annotations

from . import affiliations, config, figures, graph, graph_store, model_provenance, prompts, store
from .models import REVIEW_SLUG


def build_review_context() -> str:
    """Aggregate context for the Project Notes Review chat: the reading method, the current
    Project Notes, every Paper Notes block read so far, and the reading list."""
    parts = ["# Reading method (follow this exactly)\n\n" + store.read_method().strip()]
    parts.append(
        "# Project Notes — the running cross-paper synthesis so far\n\n"
        + model_provenance.frame("working_notes", store.read_synthesis().strip())
    )
    notes = store.all_committed_notes()
    if notes:
        block = ["# Per-paper Notes for every paper read so far"]
        for title, n in notes:
            block.append(f"\n## {title}\n\n{n.strip()}")
        parts.append(
            "# Per-paper Notes for every paper read so far\n\n"
            + model_provenance.frame("committed_paper_notes", "\n".join(block[1:]))
        )
    else:
        parts.append("# Per-paper Notes\n\nNo papers have been read in full yet.")
    parts.append("# The full reading list (papers not yet read carry their abstract)\n\n"
                 "(Whenever you name ANY paper on this list, render that name as a markdown link "
                 "to its `link:` target below (an `rc-paper:<slug>`), verbatim — including in the "
                 "rewritten SYNTHESIS — so the reader can tap it. Link the first mention in each "
                 "section; never invent a slug for a paper that isn't listed.)\n\n"
                 + model_provenance.frame(
                     "reading_list_metadata", store.reading_list_overview(),
                 ))
    return "\n\n---\n\n".join(parts)


def build_context(slug: str) -> str:
    if slug == REVIEW_SLUG:
        return build_review_context()
    parts: list[str] = []

    parts.append("# Reading method (follow this exactly)\n\n" + store.read_method().strip())

    parts.append(
        "# Project Notes — the running cross-paper synthesis so far\n\n"
        + model_provenance.frame("working_notes", store.read_synthesis().strip(), source=slug)
    )
    graph_data = graph_store.load()

    # Which prior per-paper Notes to include: every paper read so far (the default — richer
    # cross-paper grounding, at the cost of a larger context per turn), or the compact
    # citation-related selection (prior_notes_scope="related").
    # Normalized rather than tested with `== "all"` against a raw value: the branch below is
    # two-way, so before this an UNRECOGNIZED value silently took the "related" arm — which
    # happened to match the old default and would now contradict the new one.
    scope = (config.load_settings().get("prior_notes_scope") or "").strip().lower()
    if scope not in ("all", "related"):
        scope = config.DEFAULT_PRIOR_NOTES_SCOPE
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
        block = []
        for title, notes in prior:
            block.append(f"\n## {title}\n\n{notes.strip()}")
        parts.append(
            "\n".join(header) + "\n\n"
            + model_provenance.frame(
                "committed_paper_notes", "\n".join(block), source=slug,
            )
        )
    else:
        parts.append(empty)

    related = graph.related_works_for(slug, graph_data=graph_data)
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
        data = []
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
            data.append(f"- \"{r['title']}\" ({r.get('year') or 'n.d.'}; {status}{cites}) — "
                        f"{rel}: {r['reason']}{link}")
        block.append(model_provenance.frame("related_works_metadata", "\n".join(data), source=slug))
        parts.append("\n".join(block))

    citers = graph.project_citers_for(slug, graph_data=graph_data)
    if citers:
        block = [
            "# How papers in this project cite this paper",
            "(Evidence from the built reference graph. In the opening summary, explicitly "
            "explain where this paper sits in the project through the later papers that cite "
            "it. Distinguish substantive use from a background citation and stay within the "
            "evidence below.)",
        ]
        data = []
        for citer in citers:
            timing = "published later" if citer["later"] else "project citer"
            strength = "substantive citation" if citer["significant"] else "background citation"
            line = (
                f"- [{citer['title']}](rc-paper:{citer['slug']}) "
                f"({citer.get('year') or 'n.d.'}; {timing}; {strength})"
            )
            if citer.get("reason"):
                line += f" — {citer['reason']}"
            data.append(line)
            for context in citer.get("contexts") or []:
                data.append(f"  Evidence from the citing paper: “{context}”")
        block.append(model_provenance.frame("citation_contexts", "\n".join(data), source=slug))
        parts.append("\n".join(block))

    parts.append("# The full reading list (for situating this paper)\n\n"
                 "(Entries not yet read carry their abstract — enough to speak to how they "
                 "relate to this paper, but not a substitute for having read them. Entries "
                 "already read contribute their Notes above instead. Whenever you name ANY paper "
                 "on this list — not only the related works above — render that name as a markdown "
                 "link to its `link:` target given below (an `rc-paper:<slug>`), verbatim, so the "
                 "reader can tap it to open that paper in the app. Link the first mention in each "
                 "section; you need not relink every repeat.)\n\n"
                 + model_provenance.frame(
                     "reading_list_metadata", store.reading_list_overview(), source=slug,
                 ))

    entry = store.entry_markdown(slug)
    if entry:
        head = "# This paper's reading-list entry (authors, venue, context)\n\n"
        metadata = []
        year = store.year_for(slug)
        if year:
            # Stated explicitly (not only encoded in the arXiv id) so the discussion reliably
            # situates the paper on the timeline: what existed before it, what came after.
            head += ("Situate the paper in time — note which related works predate or postdate "
                     "it when weighing its contributions.\n\n")
            metadata.append(f"Published: {year}.")
        top_affiliations = affiliations.top_affiliations(slug, graph_data=graph_data)
        if top_affiliations:
            head += "Treat affiliations as identifying context, not a credibility shortcut.\n\n"
            metadata.append("Most common affiliations: " + "; ".join(top_affiliations) + ".")
        metadata.append(entry)
        parts.append(
            head + model_provenance.frame(
                "current_paper_metadata", "\n\n".join(metadata), source=slug,
            )
        )

    manifest = figures.manifest_for(slug)
    available = [
        figure for figure in (manifest or {}).get("figures", [])
        if figure.get("number") is not None
    ]
    if manifest and manifest.get("status") == "done" and available:
        block = [
            "# Figure-card visibility in this discussion",
            "(The reader can see inline image cards for ONLY the exact printed labels listed "
            "below. In ordinary discussion, write `Figure N` naturally in the explanatory "
            "paragraph so its card appears immediately afterward, without a meta announcement. "
            "If the user explicitly asks to show/include/see figures, state plainly that requested "
            "listed figures are available below. Still describe their relevant content and "
            "conclusion in words. Do not emit markdown image syntax or imply that any unlisted "
            "figure is visible.)",
        ]
        data = []
        for figure in available:
            caption = " ".join(str(figure.get("caption") or "").split())
            if len(caption) > 360:
                caption = caption[:357].rstrip() + "..."
            line = f"- Figure {figure['number']}"
            if caption:
                line += f": {caption}"
            data.append(line)
        block.append(model_provenance.frame("figure_captions", "\n".join(data), source=slug))
        parts.append("\n".join(block))
    else:
        parts.append(
            "# Figure-card visibility in this discussion\n"
            "(No paper figure images are available to the reader in this discussion. You may "
            "still explain a figure from the paper text or caption. In ordinary discussion, just "
            "describe its data, structure, and conclusion completely in words without announcing "
            "the missing image. If the user explicitly asks to show/include/see figures, state "
            "plainly that figures are not available for this paper, then provide the prose "
            "description. Never imply that the reader can see an unavailable image.)"
        )

    return "\n\n---\n\n".join(parts)


def paper_opening_message(slug: str, full_text: str, template: str | None = None) -> str:
    """The first user message of a session: hands the agent the paper text and asks for the
    opening comprehensive summary. The template is user-editable (prompts.opening_message), but
    the stored paper metadata and full text are always framed here. Compose-first drafts carry a
    fixed non-data title marker, leaving the actual title separate until this final model-input
    boundary. The legacy-slot branch safely upgrades drafts stored before that contract changed."""
    title = store.title_for(slug)
    framed = model_provenance.frame(
        "paper_full_text", full_text.strip(), source=slug,
    )
    framed_title = model_provenance.frame(
        "paper_title", title, source=slug,
    )
    if template is None:
        content = prompts.render(
            "opening_message", title=framed_title, full_text=framed,
        )
    else:
        if "{title}" in template:
            content = template.replace("{title}", framed_title)
        elif prompts.OPENING_TITLE_MARKER in template:
            content = template.replace(prompts.OPENING_TITLE_MARKER, framed_title, 1)
        else:
            content = template
            # Legacy compose-first drafts contained the actual title. The operator may have
            # changed the configured opening since one was saved, so no current-template prefix is
            # a reliable locator. A unique exact occurrence is safe to replace. Multiple matches
            # are ambiguous (especially one-character titles): rebuild the authoritative opening
            # and retain the old draft only as framed historical data instead of globally
            # expanding every matching substring into an envelope.
            occurrences = content.count(title) if title else 0
            if occurrences == 1:
                content = content.replace(title, framed_title, 1)
            elif occurrences > 1:
                legacy = model_provenance.frame(
                    "legacy_opening_draft", content, source=slug,
                )
                content = prompts.render(
                    "opening_message", title=framed_title, full_text=framed,
                )
                content += "\n\n[LEGACY EDITED OPENING]\n" + legacy
        content = content.replace("{full_text}", framed)
    if framed_title not in content:
        content += "\n\n[PAPER TITLE]\n" + framed_title
    if full_text and framed not in content:
        content += "\n\n[BEGIN PAPER FULL TEXT]\n" + framed + "\n[END PAPER FULL TEXT]"
    return content
