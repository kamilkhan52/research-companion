"""Slug derivation and citation links are fully file-driven (no hardcoded per-project data):
the slug is the colon-head by default and pinned via `<!-- slug -->`; cites come only from a
`<!-- cites -->` comment, defaulting to none."""
from __future__ import annotations

from app import store


def test_derive_slug_uses_colon_head():
    assert store.derive_slug("Orca: A Distributed Serving System") == "orca"
    assert store.derive_slug("AWQ: Activation-aware Weight Quantization") == "awq"


def test_derive_slug_without_colon_slugifies_whole_title():
    # No hardcoded special maps this — the title has no colon, so the whole thing slugifies.
    assert store.derive_slug("FlashAttention-2 and FlashDecoding++") == "flashattention-2-and-flashdecoding"


def test_slug_and_cites_come_from_comments(temp_project):
    rl = store._reading_list()
    rl.write_text(
        "# Reading list\n\n## Group\n\n"
        "**Efficient Memory Management ... with PagedAttention (vLLM)** — *read*\n"
        "<!-- slug: vllm-pagedattention -->\n\n"
        "**DistServe: Disaggregating Prefill and Decoding** — *unread*\n"
        "<!-- cites: vllm-pagedattention, orca -->\n\n"
        "**Orca: A Distributed Serving System** — *unread*\n\n",
        encoding="utf-8",
    )
    by_slug = {p.slug: p for p in store.list_papers()}
    assert "vllm-pagedattention" in by_slug              # pinned slug honored
    assert by_slug["distserve"].cites == ["vllm-pagedattention", "orca"]  # cites from comment
    assert by_slug["orca"].cites == []                   # no comment -> no cites (no fallback table)
