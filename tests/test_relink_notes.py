"""The notes-relink migration's deterministic linkifier (scripts/relink_notes)."""
from __future__ import annotations

import time
from dataclasses import dataclass

from scripts.relink_notes import _code_span_intervals, build_alias_map, linkify


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


def test_linkify_skips_tilde_and_multibacktick_and_unclosed_fences():
    amap = build_alias_map([_P("Orca", "orca")])
    assert linkify("~~~\nOrca\n~~~", amap) == "~~~\nOrca\n~~~"           # tilde fence
    assert linkify("``Orca ` x``", amap) == "``Orca ` x``"              # multi-backtick span
    assert linkify("```\nOrca\nnever closed", amap) == "```\nOrca\nnever closed"  # unclosed fence


def test_linkify_does_not_corrupt_reference_or_image_links():
    amap = build_alias_map([_P("Orca", "orca")])
    assert linkify("see [Orca][paper] now", amap) == "see [Orca][paper] now"   # reference link
    assert linkify("![Orca](img.png)", amap) == "![Orca](img.png)"             # image
    assert linkify("[Orca]", amap) == "[Orca]"                                 # shortcut ref


def test_linkify_respects_unicode_word_boundaries():
    amap = build_alias_map([_P("Orca", "orca")])
    assert linkify("αOrcaβ appears", amap) == "αOrcaβ appears"   # inside a Greek-adjacent token
    assert "[Orca](rc-paper:orca)" in linkify("_Orca_ in italics", amap)  # emphasis still links


def test_linkify_unmatched_backtick_is_linear_and_literal():
    amap = build_alias_map([_P("Orca", "orca")])
    # A lone unmatched backtick followed by many newlines must not hang (linear scan) and the
    # trailing name is plain text, so it links.
    out = linkify("`" + "\n" * 500 + "Orca", amap)
    assert "[Orca](rc-paper:orca)" in out


def test_linkify_unequal_backtick_runs_do_not_form_a_span():
    amap = build_alias_map([_P("Orca", "orca")])
    # Open run of 2, next run of 3 — different length, so no code span; Orca is literal text.
    assert "[Orca](rc-paper:orca)" in linkify("``Orca``` tail", amap)


def test_fence_closer_must_be_bare():
    amap = build_alias_map([_P("Orca", "orca")])
    # "```stillcode" mid-block is NOT a closer, so both in-block mentions stay code; ``` closes it.
    out = linkify("```\ncode Orca\n```stillcode\nmore Orca\n```\nprose Orca\n", amap)
    assert out.count("rc-paper:orca") == 1
    assert "prose [Orca](rc-paper:orca)" in out and "code Orca\n" in out  # in-block untouched


def test_fence_requires_shallow_indentation():
    amap = build_alias_map([_P("Orca", "orca")])
    # A 4-space-indented ``` is not a fence, so it must not protect the rest of the doc to EOF.
    assert "[Orca](rc-paper:orca)" in linkify("    ```\nplain Orca text", amap)


def test_shorter_fence_does_not_close_a_longer_opener():
    amap = build_alias_map([_P("Orca", "orca")])
    out = linkify("````\nin code Orca\n```\nstill code Orca\n````\nprose Orca\n", amap)
    assert out.count("rc-paper:orca") == 1 and "prose [Orca](rc-paper:orca)" in out


def test_code_span_intervals_pairs_equal_runs():
    assert _code_span_intervals("`a`b``c") == [(0, 3)]     # `a` spans; trailing `` unmatched
    assert _code_span_intervals("`x``y```z") == []          # 1,2,3 lengths never pair


def test_linkify_is_linear_over_many_backtick_runs():
    # Thousands of runs must stay fast (single-pass interval scan, no per-run rescans).
    amap = build_alias_map([_P("Orca", "orca")])
    text = ("`x " * 20000) + "trailing Orca"
    start = time.perf_counter()
    out = linkify(text, amap)
    assert time.perf_counter() - start < 1.0
    assert "[Orca](rc-paper:orca)" in out
