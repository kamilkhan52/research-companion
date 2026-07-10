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
