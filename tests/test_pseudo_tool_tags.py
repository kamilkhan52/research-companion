"""Pseudo tool-tag stripping (polish plan G.2): the model sometimes narrates tool intent as
made-up XML like `<search for="...">` inside its canonical answer (observed live). parse()
and canonical_prefix() convert those to muted `*Searched: …*` status lines; fenced code is
untouched; a half-arrived tag is held back from the live stream like a forming section
marker, so the visible prefix stays append-only."""
from __future__ import annotations

from app import agent

PROTO = "### CANONICAL ###\n{body}\n### STATE ###\nin_discussion\n### END ###"


def test_parse_converts_search_tags_to_status_lines():
    body = ('Before.\n\n<search for="vAttention GPU virtual memory adoption">'
            ' <search for="Vidur simulator extensions">\n\nAfter.')
    turn = agent.parse(PROTO.format(body=body))
    assert "<search" not in turn.canonical
    assert "*Searched: vAttention GPU virtual memory adoption*" in turn.canonical
    assert "*Searched: Vidur simulator extensions*" in turn.canonical
    assert turn.canonical.startswith("Before.")
    assert turn.canonical.endswith("After.")
    assert "\n\n\n" not in turn.canonical


def test_parse_handles_variants_and_orphan_closers():
    body = ('<web_search query="kv cache paging"></web_search> and prose </search> done')
    turn = agent.parse(PROTO.format(body=body))
    assert "<web_search" not in turn.canonical
    assert "</search>" not in turn.canonical
    assert "*Searched: kv cache paging*" in turn.canonical
    assert "and prose" in turn.canonical and "done" in turn.canonical


def test_fenced_code_is_left_alone():
    body = 'Text.\n\n```xml\n<search for="not a leak">\n```\n\nMore.'
    turn = agent.parse(PROTO.format(body=body))
    assert '<search for="not a leak">' in turn.canonical
    assert "*Searched:" not in turn.canonical


def test_ordinary_angle_brackets_survive():
    body = "For x < 5 and vectors <a, b>, HTML like <em>keeps</em> rendering as text."
    turn = agent.parse(PROTO.format(body=body))
    assert turn.canonical == body


def test_canonical_prefix_holds_back_partial_tag_then_converts():
    base = "### CANONICAL ###\nThe answer so far. "
    # Tag mid-arrival: nothing of it shows.
    partial = base + '<search for="Vidur simu'
    shown = agent.canonical_prefix(partial)
    assert shown == "The answer so far."
    # Tag completed: it shows as the converted status line, appended after the prior prefix.
    complete = base + '<search for="Vidur simulator"> Then more prose.'
    shown_after = agent.canonical_prefix(complete)
    assert shown_after.startswith(shown)
    assert "*Searched: Vidur simulator*" in shown_after
    assert shown_after.endswith("Then more prose.")
    assert "<search" not in shown_after


def test_canonical_prefix_holds_back_partial_closing_tag():
    base = "### CANONICAL ###\nProse. "
    assert agent.canonical_prefix(base + "</sear") == "Prose."


def test_holdback_never_swallows_ordinary_prose():
    """Review round 1: the holdback must not suppress legitimate live text. Comparisons,
    generics, HTML mentions, and name-like words stream through in full."""
    base = "### CANONICAL ###\n"
    for tail in (
        "For x < sigma is small.",       # comparison + spaced '<'
        "the <search strategy we use",   # tool name followed by a non-attribute word
        "use <browser automation",       # name-prefix outgrown into another word
        "a Vec<f32> of values",
        "HTML like <em>hi</em> renders",
        "x<sigma denotes the bound",     # unspaced comparison, name prefix outgrown
    ):
        assert agent.canonical_prefix(base + tail) == tail

    # Momentary holdbacks that resolve as more text arrives (could still become a tag).
    assert agent.canonical_prefix(base + "see <") == "see"
    assert agent.canonical_prefix(base + "see <sear") == "see"
    assert agent.canonical_prefix(base + "see <search for=") == "see"


def test_no_marker_fallback_is_also_cleaned():
    """Review round 1: the protocol-drift path (no section markers at all) must apply the
    same cleanup before the raw text is persisted and narrated."""
    turn = agent.parse('Plain answer. <search for="kv cache"> More.')
    assert "<search" not in turn.canonical
    assert "*Searched: kv cache*" in turn.canonical
