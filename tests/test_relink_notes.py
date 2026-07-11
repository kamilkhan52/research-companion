"""The notes-relink migration's deterministic linkifier (scripts/relink_notes)."""
from __future__ import annotations

from dataclasses import dataclass

from scripts.relink_notes import build_alias_map, linkify


@dataclass
class _P:
    title: str
    slug: str


PAPERS = [
    _P("Orca: A Distributed Serving System for Transformer Models", "orca"),
    _P("DistServe: Disaggregating Prefill and Decoding", "distserve"),
    _P("Sarathi-Serve", "sarathi-serve"),
]


def test_build_alias_map_covers_title_head_and_slug():
    amap = build_alias_map(PAPERS)
    assert amap["orca"] == "orca"                      # title head before the colon
    assert amap["distserve"] == "distserve"            # title head
    assert amap["sarathi-serve"] == "sarathi-serve"    # slug verbatim
    assert amap["sarathi serve"] == "sarathi-serve"    # slug spaced
    # A curated alias wins.
    amap2 = build_alias_map(PAPERS, curated={"vLLM": "vllm-pagedattention"})
    assert amap2["vllm"] == "vllm-pagedattention"


def test_linkify_links_first_mention_only():
    amap = build_alias_map(PAPERS)
    out = linkify("Orca introduced batching. Later, Orca was extended.", amap)
    assert out.count("(rc-paper:orca)") == 1
    assert out.startswith("[Orca](rc-paper:orca) introduced")
    assert out.endswith("Later, Orca was extended.")  # second mention untouched


def test_linkify_is_case_insensitive_and_keeps_label():
    amap = build_alias_map(PAPERS)
    assert "[DISTSERVE](rc-paper:distserve)" in linkify("See DISTSERVE here.", amap)


def test_linkify_skips_existing_links_and_code():
    amap = build_alias_map(PAPERS)
    # Already a link -> the first "linkable" Orca is inside a link; the plain one after gets linked.
    text = "[Orca](rc-paper:orca) and `Orca` and then Orca again."
    out = linkify(text, amap)
    assert out.count("rc-paper:orca") == 1                 # existing link preserved, no new one added
    assert "`Orca`" in out                                 # code span untouched
    assert out.endswith("then Orca again.")                # slug already "linked" via the existing one


def test_linkify_does_not_self_link():
    amap = build_alias_map(PAPERS)
    out = linkify("Orca builds on DistServe.", amap, exclude_slug="orca")
    assert "rc-paper:orca" not in out                      # own paper not linked
    assert "[DistServe](rc-paper:distserve)" in out


def test_linkify_single_word_alias_requires_capitalization():
    # A one-word paper name that collides with a common word ("Park" the paper vs "park" the verb).
    amap = build_alias_map([_P("Park", "park"), _P("DistServe", "distserve")])
    out = linkify("You park the KV cache; see Park for the RL angle.", amap)
    assert "[Park](rc-paper:park)" in out          # capitalized paper mention linked
    assert "You park the" in out                   # lowercase verb left alone
    assert out.count("rc-paper:park") == 1


def test_linkify_loose_alias_allows_lowercase():
    amap = build_alias_map([_P("PagedAttention paper", "vllm-pagedattention")],
                           curated={"vLLM": "vllm-pagedattention"})
    out = linkify("Built on vLLM.", amap, loose_aliases=frozenset({"vllm"}))
    assert "[vLLM](rc-paper:vllm-pagedattention)" in out


def test_linkify_prefers_longer_alias():
    amap = build_alias_map([_P("Sarathi-Serve", "sarathi-serve"),
                            _P("Sarathi", "sarathi")])
    out = linkify("We compare Sarathi-Serve to baselines.", amap)
    assert "[Sarathi-Serve](rc-paper:sarathi-serve)" in out
